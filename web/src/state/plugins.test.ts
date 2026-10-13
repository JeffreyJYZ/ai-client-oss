import { beforeEach, describe, expect, test } from "bun:test";
import { type Settings, settingsDefaults } from "@lib/db";
import { PluginLoadFailed } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import {
	installPlugin,
	loadPlugin,
	MANIFEST_FILE,
	type PluginInstaller,
	type PluginModule,
	type PluginSource,
	unloadPlugin,
} from "@lib/plugins/loader";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { Duration, Effect } from "effect";
import type { ComponentType } from "react";
import {
	makePluginsStore,
	type PluginsDeps,
	type PluginsStore,
} from "@/state/plugins";

/**
 * The plugin manager store. No DOM: the store is a module variable plus a
 * listener set (the `state/ui.test.ts` shape), driven directly. Every seam the
 * store depends on is injected, so nothing here touches IndexedDB, the real
 * runtime or React — and the **real** loader is used for the load/unload half,
 * against a fresh set of real host registries, so "loads and registers" and
 * "unloads and leaves no trace" are asserted at the registry rather than
 * against a mock's own bookkeeping.
 */

const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

// The plugin log is a module-level buffer (it is what the section's panel
// reads), so a line from one test would otherwise be visible to the next.
beforeEach(() => {
	clearLog();
});

const manifestOf = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	id: "t18.fixture",
	name: "T18 fixture",
	version: "1.0.0",
	apiVersion: "0.1",
	entry: "main.js",
	capabilities: ["net"],
	...overrides,
});

/** The `files` record a paste install receives: `plugin.json` plus the entry. */
const filesOf = (
	overrides: Record<string, unknown> = {},
): Record<string, string> => ({
	[MANIFEST_FILE]: JSON.stringify(manifestOf(overrides)),
	"main.js": "export default { setup() {} }",
});

interface HarnessOptions {
	/** Plugin ids whose load must fail, so a partial failure can be asserted. */
	readonly failLoadFor?: readonly string[];
	/** Raw manifests the source lists that were never installed here. */
	readonly extraManifests?: readonly unknown[];
	readonly fetchText?: PluginsDeps["fetchText"];
	/** The persisted settings the store boots with. */
	readonly initialSettings?: Settings;
}

interface Harness {
	readonly store: PluginsStore;
	readonly registries: HostServicesShape;
	readonly installed: Map<string, { readonly files: Record<string, string> }>;
	/** Every plugin id the manager asked to load, in order. */
	readonly loads: readonly string[];
	/** Every plugin id the manager asked to unload, in order. */
	readonly unloads: readonly string[];
	readonly settings: () => Settings;
	readonly notifications: () => number;
}

const makeHarness = (options: HarnessOptions = {}): Harness => {
	const registries = Effect.runSync(
		HostServices.pipe(Effect.provide(HostLayer)),
	);
	let settings: Settings = options.initialSettings ?? settingsDefaults();
	const listeners = new Set<() => void>();
	let notifications = 0;
	const installed = new Map<string, { files: Record<string, string> }>();
	const loads: string[] = [];
	const unloads: string[] = [];
	const failing = new Set(options.failLoadFor ?? []);
	const component: ComponentType<Record<string, unknown>> = () => null;

	const installer: PluginInstaller = {
		write: (id, _manifest, files) =>
			Effect.sync(() => {
				installed.set(id, { files });
			}),
		remove: (id) =>
			Effect.sync(() => {
				installed.delete(id);
			}),
	};

	const source: PluginSource = {
		list: () => Effect.succeed([]),
		read: () => Effect.succeed("export default { setup() {} }"),
	};

	/** The module a plugin id's entry evaluates to: one header marker. */
	const moduleOf = (id: string): PluginModule => ({
		setup: (host) => {
			host.ui.register({
				id: `marker.${id}`,
				slot: "app.header.actions",
				component,
			});
		},
	});

	const deps: PluginsDeps = {
		readSettings: () => settings,
		writeSettings: (patch) => {
			settings = { ...settings, ...patch };
			notifications += 1;
			for (const listener of listeners) listener();
		},
		subscribeSettings: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		listManifests: () =>
			Effect.succeed([
				...(options.extraManifests ?? []),
				...[...installed.values()].map(
					(record) =>
						JSON.parse(record.files[MANIFEST_FILE] ?? "null") as unknown,
				),
			]),
		install: (id, files) => installPlugin(id, files, installer),
		uninstall: (id) => installer.remove(id),
		load: (id, raw) =>
			// `Effect.suspend` so an attempt is counted when it happens, not when
			// it is planned — a failed load counts too.
			Effect.suspend(() => {
				loads.push(id);
				return loadPlugin(raw, {
					source,
					importer: failing.has(id)
						? {
								importSource: () =>
									Effect.fail(
										new PluginLoadFailed({
											detail: `plugin "${id}" refused to load`,
											pluginId: id,
										}),
									),
							}
						: { importSource: () => Effect.succeed(moduleOf(id)) },
					hostFor: (pluginId, scope) => makeHost(registries, pluginId, scope),
					timeout: Duration.millis(200),
				});
			}),
		unload: (loaded) =>
			unloadPlugin(loaded).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						unloads.push(loaded.manifest.id);
					}),
				),
			),
		fetchText:
			options.fetchText ??
			((url) => Effect.fail(`no fetch stub configured for ${url}`)),
		run: (effect) => {
			void Effect.runPromiseExit(Effect.provide(effect, HostLayer));
		},
	};

	return {
		store: makePluginsStore(deps),
		registries,
		installed,
		loads,
		unloads,
		settings: () => settings,
		notifications: () => notifications,
	};
};

/** The one plugin's runtime state once it is the only one installed. */
const only = (store: PluginsStore) => {
	const plugin = store.getPlugins().plugins[0];
	if (plugin === undefined) throw new Error("no plugin in the snapshot");
	return plugin;
};

describe("master switch", () => {
	test("defaults off and flipping it persists", () => {
		const h = makeHarness();
		h.store.start();

		expect(h.store.getPlugins().enabled).toBe(false);
		expect(h.settings().pluginsEnabled).toBe(false);

		h.store.setPluginsEnabled(true);

		expect(h.store.getPlugins().enabled).toBe(true);
		expect(h.settings().pluginsEnabled).toBe(true);

		h.store.setPluginsEnabled(false);
		expect(h.settings().pluginsEnabled).toBe(false);
	});

	test("the snapshot is referentially stable between changes", () => {
		// `useSyncExternalStore` compares `getSnapshot()` by identity on every
		// render: a fresh object or array per read is an infinite render loop.
		const h = makeHarness();
		h.store.start();

		const first = h.store.getPlugins();
		expect(h.store.getPlugins()).toBe(first);
		expect(h.store.getPlugins().plugins).toBe(first.plugins);
	});

	test("notifies subscribers once per change", () => {
		const h = makeHarness();
		h.store.start();
		const seen: boolean[] = [];
		const unsubscribe = h.store.subscribe(() => {
			seen.push(h.store.getPlugins().enabled);
		});

		h.store.setPluginsEnabled(true);
		expect(seen).toEqual([true]);

		unsubscribe();
		h.store.setPluginsEnabled(false);
		expect(seen).toEqual([true]);
	});
});

describe("install", () => {
	test("refuses a manifest that is not JSON, with the file named", async () => {
		const h = makeHarness();
		h.store.start();

		h.store.installFromText("", { [MANIFEST_FILE]: "{ not json" });
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(h.store.getPlugins().notice?.text ?? "").toContain(MANIFEST_FILE);
		expect(h.installed.size).toBe(0);
	});

	test("refuses a manifest that fails the schema, with the decode detail", async () => {
		const h = makeHarness();
		h.store.start();

		// No `name`: the schema's own rejection, not a hand-written message.
		h.store.installFromText("", {
			[MANIFEST_FILE]: JSON.stringify({ id: "t18.noname" }),
		});
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(h.store.getPlugins().notice?.text ?? "").toContain("name");
		expect(h.installed.size).toBe(0);
	});

	test("refuses an id that disagrees with the manifest", async () => {
		const h = makeHarness();
		h.store.start();

		h.store.installFromText("not.the.id", filesOf());
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(h.store.getPlugins().notice?.text ?? "").toContain("t18.fixture");
		expect(h.installed.size).toBe(0);
	});

	test("stores a valid plugin disabled and lists what the manifest declares", async () => {
		const h = makeHarness();
		h.store.start();

		h.store.installFromText("", filesOf({ author: "Acme" }));
		await tick();

		expect([...h.installed.keys()]).toEqual(["t18.fixture"]);
		expect(h.store.getPlugins().notice?.ok).toBe(true);

		const plugin = only(h.store);
		expect(plugin.state.enabled).toBe(false);
		expect(plugin.status).toBe("disabled");
		expect(plugin.manifest?.name).toBe("T18 fixture");
		expect(plugin.manifest?.author).toBe("Acme");
		expect(plugin.manifest?.capabilities).toEqual(["net"]);
		expect(h.settings().plugins.map((entry) => entry.id)).toEqual([
			"t18.fixture",
		]);
	});

	test("refuses an installed manifest that is not in the store", async () => {
		const h = makeHarness();
		h.store.start();

		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.missing", true);
		await tick();

		const plugin = only(h.store);
		expect(plugin.status).toBe("failed");
		expect(plugin.error ?? "").toContain("not installed");
	});
});

describe("install from a URL", () => {
	test("installs the files a URL returns as JSON", async () => {
		const files = filesOf({ id: "t18.from-url" });
		const h = makeHarness({
			fetchText: () => Effect.succeed(JSON.stringify(files)),
		});
		h.store.start();

		h.store.installFromUrl("https://example.test/plugin.json");
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(true);
		expect([...h.installed.keys()]).toEqual(["t18.from-url"]);
	});

	test("refuses an envelope that is not a file record, with the decode detail", async () => {
		const h = makeHarness({ fetchText: () => Effect.succeed("[1,2,3]") });
		h.store.start();

		h.store.installFromUrl("https://example.test/plugin.json");
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(h.store.getPlugins().notice?.text ?? "").not.toBe("");
		expect(h.installed.size).toBe(0);
	});

	test("reports a fetch failure instead of throwing", async () => {
		const h = makeHarness({
			fetchText: (url) => Effect.fail(`could not fetch ${url}`),
		});
		h.store.start();

		h.store.installFromUrl("https://example.test/missing.json");
		await tick();

		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(h.store.getPlugins().notice?.text ?? "").toContain(
			"example.test/missing.json",
		);
	});
});

describe("enable and disable", () => {
	test("enabling loads and registers; disabling unloads and leaves no trace", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();

		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();

		expect(only(h.store).status).toBe("loaded");
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);

		h.store.setPluginEnabled("t18.fixture", false);
		await tick();

		expect(only(h.store).status).toBe("disabled");
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);
	});

	test("a plugin enabled while the master switch is off never loads", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();

		h.store.setPluginEnabled("t18.fixture", true);
		await tick();

		expect(only(h.store).status).toBe("disabled");
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);

		// Turning the master switch on is what loads it — no reload, no re-install.
		h.store.setPluginsEnabled(true);
		await tick();

		expect(only(h.store).status).toBe("loaded");
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);
	});

	test("turning the master switch off unloads without a reload", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);

		h.store.setPluginsEnabled(false);
		await tick();

		expect(only(h.store).status).toBe("disabled");
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);
	});

	test("a failing plugin reports the error while the others stay loaded", async () => {
		const h = makeHarness({ failLoadFor: ["t18.bad"] });
		h.store.start();
		h.store.installFromText("", filesOf());
		h.store.installFromText("", filesOf({ id: "t18.bad", name: "Bad" }));
		await tick();

		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		h.store.setPluginEnabled("t18.bad", true);
		await tick();

		const byId = new Map(
			h.store.getPlugins().plugins.map((plugin) => [plugin.state.id, plugin]),
		);
		expect(byId.get("t18.fixture")?.status).toBe("loaded");
		expect(byId.get("t18.bad")?.status).toBe("failed");
		expect(byId.get("t18.bad")?.error ?? "").toContain("refused to load");
		// The good plugin's registration survives the bad plugin's failure.
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);
		expect(Effect.runSync(h.registries.ui.entries())[0]?.owner).toBe(
			"t18.fixture",
		);
	});

	test("an enabled plugin already installed loads once at boot, with no spurious failure", async () => {
		// The regression this pins: the store used to reconcile *before* the
		// source had been listed, so every enabled-at-boot plugin was reported as
		// "not installed" and then loaded a moment later.
		const h = makeHarness({
			extraManifests: [manifestOf()],
			initialSettings: {
				...settingsDefaults(),
				pluginsEnabled: true,
				plugins: [
					{
						id: "t18.fixture",
						enabled: true,
						version: "1.0.0",
						capabilities: ["net"],
						data: {},
					},
				],
			},
		});

		h.store.start();
		await tick();
		await tick();

		const plugin = only(h.store);
		expect(plugin.status).toBe("loaded");
		expect(plugin.error).toBeUndefined();
		expect(h.loads).toEqual(["t18.fixture"]);
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);
		// The strongest form of "no spurious failure": the manager's own log has
		// the successful load and nothing that says the plugin was missing.
		const lines = getLogSnapshot().map((entry) => entry.message);
		expect(lines).toContain("loaded version 1.0.0");
		expect(lines.filter((line) => line.includes("not installed"))).toEqual([]);
	});

	test("a load that fails is attempted once, and retried only when the user asks again", async () => {
		const h = makeHarness({ failLoadFor: ["t18.fixture"] });
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();

		expect(only(h.store).status).toBe("failed");
		expect(h.loads).toEqual(["t18.fixture"]);

		// Nothing retries it on its own — not even a later settings write.
		await tick();
		h.store.setPluginsEnabled(true);
		await tick();
		expect(h.loads).toEqual(["t18.fixture"]);

		// The user's own gesture does.
		h.store.setPluginEnabled("t18.fixture", false);
		await tick();
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();
		expect(h.loads).toEqual(["t18.fixture", "t18.fixture"]);
	});

	test("reload unloads and loads again, leaving one registration", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();
		expect(h.loads).toEqual(["t18.fixture"]);

		h.store.reload("t18.fixture");
		await tick();

		expect(only(h.store).status).toBe("loaded");
		// A reload is a real unload plus a real load — the second `loads` entry is
		// what distinguishes it from a no-op — and the plugin ends with exactly one
		// registration rather than a stale one plus a fresh one.
		expect(h.loads).toEqual(["t18.fixture", "t18.fixture"]);
		expect(h.unloads).toEqual(["t18.fixture"]);
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);
	});
});

describe("the installed list", () => {
	test("lists a plugin the source holds but nothing persisted", async () => {
		const h = makeHarness({
			extraManifests: [manifestOf({ id: "t18.on-disk" })],
		});
		h.store.start();
		await tick();

		const plugin = only(h.store);
		expect(plugin.state.id).toBe("t18.on-disk");
		expect(plugin.state.enabled).toBe(false);
		expect(plugin.status).toBe("disabled");
		expect(plugin.manifest?.name).toBe("T18 fixture");
	});

	test("an invalid manifest in the store is listed as failed with its reason", async () => {
		const h = makeHarness({
			extraManifests: [{ id: "t18.broken" }],
		});
		h.store.start();
		await tick();

		const plugin = only(h.store);
		expect(plugin.status).toBe("failed");
		expect(plugin.error ?? "").toContain("name");
		expect(plugin.manifest).toBeNull();
	});
});

describe("uninstall", () => {
	test("unloads, removes the files and drops the persisted entry", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);

		h.store.uninstall("t18.fixture");
		await tick();

		expect(h.installed.size).toBe(0);
		expect(h.settings().plugins).toEqual([]);
		expect(h.store.getPlugins().plugins).toEqual([]);
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);
	});
});
