import { describe, expect, test } from "bun:test";
import {
	ApiVersionIncompatible,
	ManifestInvalid,
	type PluginError,
	PluginFault,
	PluginLoadFailed,
} from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import {
	type LoadDeps,
	loadPlugin,
	type ModuleImporter,
	type PluginModule,
	type PluginSource,
	unloadPlugin,
} from "@lib/plugins/loader";
import { Duration, Effect, Exit, Logger } from "effect";
import type { ComponentType } from "react";

/**
 * A fresh set of registries per test — registrations are the subject, so a
 * shared set would leak entries between tests (the same reason as
 * `host.test.ts`).
 */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const component = (): ComponentType<Record<string, unknown>> => () => null;

/** A raw `plugin.json` with every required field; `overrides` replaces defaults. */
const rawManifest = (overrides: Record<string, unknown> = {}): unknown => ({
	id: "acme.test",
	name: "Test plugin",
	version: "1.0.0",
	apiVersion: "0.1",
	...overrides,
});

/** A fake `PluginSource` — the real adapters are Task 17, so the loader is fed text directly. */
const sourceOf = (text: string, onRead?: () => void): PluginSource => ({
	list: () => Effect.succeed([]),
	read: () => {
		onRead?.();
		return Effect.succeed(text);
	},
});

/** A fake `ModuleImporter` — the real one is a browser blob import (Task 17). */
const importerOf = (module: PluginModule): ModuleImporter => ({
	importSource: () => Effect.succeed(module),
});

interface DepOptions {
	readonly source?: PluginSource;
	readonly importer?: ModuleImporter;
	/** The app version the built host reports, for the `engines.app` check. */
	readonly app?: string;
	/** The plugin API version the built host reports. */
	readonly api?: string;
	readonly timeout?: Duration.Input;
}

const depsOf = (
	registries: HostServicesShape,
	options: DepOptions = {},
): LoadDeps => ({
	source: options.source ?? sourceOf("export default { setup() {} }"),
	importer: options.importer ?? importerOf({ setup: () => {} }),
	hostFor: (pluginId, scope) =>
		makeHost(
			{
				...registries,
				version: {
					app: options.app ?? registries.version.app,
					api: options.api ?? registries.version.api,
				},
			},
			pluginId,
			scope,
		),
	timeout: options.timeout ?? Duration.millis(200),
});

/** Run an expected-to-fail load and hand back its typed error. */
const loadError = (
	effect: Effect.Effect<unknown, PluginError>,
): Promise<PluginError> => Effect.runPromise(Effect.flip(effect));

/** Run a load and capture whatever the subsystem logged. */
const logsOf = async (
	effect: Effect.Effect<unknown, PluginError>,
): Promise<{
	exit: Exit.Exit<unknown, PluginError>;
	messages: readonly string[];
}> => {
	const messages: string[] = [];
	const logger = Logger.make<unknown, void>((options) => {
		const parts: readonly unknown[] = Array.isArray(options.message)
			? options.message
			: [options.message];
		messages.push(
			parts
				.map((part) => (typeof part === "string" ? part : String(part)))
				.join(" "),
		);
	});
	const exit = await Effect.runPromiseExit(
		Effect.provide(effect, Logger.layer([logger])),
	);
	return { exit, messages };
};

describe("loadPlugin", () => {
	test("an invalid manifest is a ManifestInvalid and never reaches setup", async () => {
		let setupCalls = 0;
		const error = await loadError(
			loadPlugin(
				{ id: "" },
				depsOf(services(), {
					importer: importerOf({
						setup: () => {
							setupCalls += 1;
						},
					}),
				}),
			),
		);

		expect(error).toBeInstanceOf(ManifestInvalid);
		expect(setupCalls).toBe(0);
	});

	test("a setup that throws is a PluginFault; the scope closes and the app survives", async () => {
		const registries = services();
		const error = await loadError(
			loadPlugin(
				rawManifest(),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "kept",
								slot: "app.header",
								component: component(),
							});
							throw new Error("boom");
						},
					}),
				}),
			),
		);

		expect(error).toBeInstanceOf(PluginFault);
		expect(error.detail).toContain("boom");
		// The registration made before the throw was collected when the scope
		// closed, so a faulted plugin leaves no trace.
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);

		// The app is alive: a following plugin still loads and registers.
		const loaded = await Effect.runPromise(
			loadPlugin(
				rawManifest({ id: "acme.after" }),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "after",
								slot: "app.header",
								component: component(),
							});
						},
					}),
				}),
			),
		);
		expect(loaded.manifest.id).toBe("acme.after");
		expect(Effect.runSync(registries.ui.entries()).length).toBe(1);
	});

	test("a load step that never returns times out as a PluginLoadFailed and closes the scope", async () => {
		const registries = services();
		const error = await loadError(
			loadPlugin(
				rawManifest(),
				depsOf(registries, {
					importer: { importSource: () => Effect.never },
					timeout: Duration.millis(20),
				}),
			),
		);

		expect(error).toBeInstanceOf(PluginLoadFailed);
		expect(error.detail).toContain("20ms");
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
	});

	test("a registration into an unknown slot is dropped while the plugin still loads", async () => {
		const registries = services();
		const loaded = await Effect.runPromise(
			loadPlugin(
				rawManifest(),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "bad",
								// A plugin is untyped JavaScript here; the host must
								// validate the value it is handed.
								slot: "not.a.slot" as unknown as SlotId,
								component: component(),
							});
							host.tools.register({ id: "tool" });
						},
					}),
				}),
			),
		);

		expect(loaded.manifest.id).toBe("acme.test");
		// The fault is dropped; the plugin survives and its good registration stays.
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
		expect(Effect.runSync(registries.tools.ownedBy("acme.test")).length).toBe(
			1,
		);
	});

	test("every registration a plugin makes is owned by the manifest's id", async () => {
		const registries = services();
		const loaded = await Effect.runPromise(
			loadPlugin(
				rawManifest({ id: "acme.owner" }),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "owned",
								slot: "app.header",
								component: component(),
							});
						},
					}),
				}),
			),
		);

		expect(loaded.manifest.id).toBe("acme.owner");
		// Identity is the manifest's, not anything the module could claim.
		expect(Effect.runSync(registries.ui.ownedBy("acme.owner")).length).toBe(1);
	});
});

describe("version checks", () => {
	test("a different apiVersion major is refused as ApiVersionIncompatible before any read", async () => {
		const registries = services();
		let reads = 0;
		let setupCalls = 0;
		const error = await loadError(
			loadPlugin(
				rawManifest({ apiVersion: "1.0" }),
				depsOf(registries, {
					source: sourceOf("x", () => {
						reads += 1;
					}),
					importer: importerOf({
						setup: () => {
							setupCalls += 1;
						},
					}),
				}),
			),
		);

		expect(error).toBeInstanceOf(ApiVersionIncompatible);
		// The refusal short-circuits: no entry is read and setup never runs.
		expect(reads).toBe(0);
		expect(setupCalls).toBe(0);
	});

	// Ruling R9: this is the case the check must be able to REFUSE. `host.version.app`
	// is a real version (Task 3's fix), so an unsatisfiable bound is a refusal.
	test("an engines.app bound the host cannot satisfy refuses the load", async () => {
		const registries = services();
		let setupCalls = 0;
		const error = await loadError(
			loadPlugin(
				rawManifest({ engines: { app: ">=99.0.0" } }),
				depsOf(registries, {
					app: "0.2.3",
					api: "0.1",
					importer: importerOf({
						setup: () => {
							setupCalls += 1;
						},
					}),
				}),
			),
		);

		expect(error).toBeInstanceOf(ApiVersionIncompatible);
		expect(error.detail).toContain("99.0.0");
		expect(error.detail).toContain("0.2.3");
		expect(setupCalls).toBe(0);
	});

	// The other by-design case: a different minor is a warning, never a refusal.
	test("a different apiVersion minor warns and still loads", async () => {
		const registries = services();
		const { exit, messages } = await logsOf(
			loadPlugin(rawManifest({ apiVersion: "0.2" }), depsOf(registries)),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(messages.join("\n")).toContain("0.2");
	});

	// Unparsable is a warning, never a refusal (spec §10).
	test("an unparsable apiVersion warns and still loads", async () => {
		const registries = services();
		const { exit, messages } = await logsOf(
			loadPlugin(rawManifest({ apiVersion: "next" }), depsOf(registries)),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(messages.join("\n")).toContain("next");
	});
});

describe("load failures", () => {
	test("a source read failure is a PluginLoadFailed", async () => {
		const error = await loadError(
			loadPlugin(
				rawManifest(),
				depsOf(services(), {
					source: {
						list: () => Effect.succeed([]),
						read: () =>
							Effect.fail(new PluginLoadFailed({ detail: "no such file" })),
					},
				}),
			),
		);

		expect(error).toBeInstanceOf(PluginLoadFailed);
		expect(error.detail).toContain("no such file");
	});

	test("an import failure is a PluginLoadFailed", async () => {
		const error = await loadError(
			loadPlugin(
				rawManifest(),
				depsOf(services(), {
					importer: {
						importSource: () =>
							Effect.fail(new PluginLoadFailed({ detail: "syntax error" })),
					},
				}),
			),
		);

		expect(error).toBeInstanceOf(PluginLoadFailed);
		expect(error.detail).toContain("syntax error");
	});
});

describe("unloadPlugin", () => {
	test("removes every registration the plugin made", async () => {
		const registries = services();
		const loaded = await Effect.runPromise(
			loadPlugin(
				rawManifest(),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "u1",
								slot: "app.header",
								component: component(),
							});
							host.ui.register({
								id: "u2",
								slot: "app.banner",
								component: component(),
							});
							host.tools.register({ id: "t1" });
						},
					}),
				}),
			),
		);

		expect(Effect.runSync(registries.ui.ownedBy("acme.test")).length).toBe(2);

		await Effect.runPromise(unloadPlugin(loaded));

		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
		expect(Effect.runSync(registries.tools.entries())).toEqual([]);
	});

	test("disposes the handle a setup returned, once, and before its registrations", async () => {
		const registries = services();
		let disposed = 0;
		// The count of the plugin's own registrations at the moment its handle
		// is disposed pins the order spec §2 requires: the returned handle goes
		// first, then the registrations.
		let entriesWhenDisposed: number | undefined;
		const loaded = await Effect.runPromise(
			loadPlugin(
				rawManifest(),
				depsOf(registries, {
					importer: importerOf({
						setup: (host) => {
							host.ui.register({
								id: "u",
								slot: "app.header",
								component: component(),
							});
							return {
								dispose: () => {
									disposed += 1;
									entriesWhenDisposed = Effect.runSync(
										registries.ui.entries(),
									).length;
								},
							};
						},
					}),
				}),
			),
		);

		expect(disposed).toBe(0);
		await Effect.runPromise(unloadPlugin(loaded));
		expect(disposed).toBe(1);
		expect(entriesWhenDisposed).toBe(1);
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
		// Closing a scope twice is a no-op, so unload is idempotent.
		await Effect.runPromise(unloadPlugin(loaded));
		expect(disposed).toBe(1);
	});
});
