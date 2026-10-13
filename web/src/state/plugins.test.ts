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
	activatePlugin,
	installPlugin,
	MANIFEST_FILE,
	type PluginInstaller,
	type PluginModule,
	type PluginSource,
	preparePlugin,
	unloadPlugin,
} from "@lib/plugins/loader";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { Duration, Effect } from "effect";
import {
	declaredBodyOverLimit,
	MAX_SETTLE_ROUNDS,
	makePluginsStore,
	PLUGIN_SOURCE_MAX_CHARS,
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

/** The module a plugin id's entry evaluates to: one header marker. */
const moduleOf = (id: string): PluginModule => ({
	setup: (host) => {
		host.ui.register({
			id: `marker.${id}`,
			slot: "app.header.actions",
			component: () => null,
		});
	},
});

interface HarnessOptions {
	/** Plugin ids whose load must fail, so a partial failure can be asserted. */
	readonly failLoadFor?: readonly string[];
	/** Raw manifests the source lists that were never installed here. */
	readonly extraManifests?: readonly unknown[];
	readonly fetchText?: PluginsDeps["fetchText"];
	/** The persisted settings the store boots with. */
	readonly initialSettings?: Settings;
	/**
	 * Run when a load actually executes (not when it is planned), so a test can
	 * make one load produce new work for the settle loop's next round.
	 */
	readonly onLoad?: (id: string) => void;
	/**
	 * The module an entry's text evaluates to, when a test needs one that does
	 * more than the default header marker (a theme-shape plugin whose `dispose`
	 * retracts its `setup`, or one whose `setup` throws).
	 */
	readonly moduleFor?: (id: string, text: string) => PluginModule;
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
	/** Per-plugin entry text; mutate it to simulate an edit of the source. */
	readonly entrySources: Map<string, string>;
	/** `load:<id>` / `unload:<id>` in the order they were asked for. */
	readonly trace: readonly string[];
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
	const trace: string[] = [];
	/** Entry text per plugin id, so a test can change a plugin's source. */
	const entrySources = new Map<string, string>();
	const sourceText = (id: string): string =>
		entrySources.get(id) ?? "export default { setup() {} }";
	const failing = new Set(options.failLoadFor ?? []);

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
		read: (id) => Effect.succeed(sourceText(id)),
	};

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
		prepare: (id, raw) =>
			// `Effect.suspend` so an attempt is counted when it happens, not when
			// it is planned — a failed load counts too.
			Effect.suspend(() => {
				loads.push(id);
				trace.push(`load:${id}`);
				// A load that makes new work for the settle loop's next round
				// (finding 2's chain); runs when the load executes, not when it
				// is planned.
				options.onLoad?.(id);
				return preparePlugin(raw, {
					source,
					// The importer reads the text the source returned, so a changed
					// `entrySources` entry is what a reload actually sees — and a
					// `BROKEN` marker stands in for source that cannot be imported.
					importer: {
						importSource: (text) =>
							failing.has(id) || text.includes("BROKEN")
								? Effect.fail(
										new PluginLoadFailed({
											detail: failing.has(id)
												? `plugin "${id}" refused to load`
												: `plugin "${id}" failed to import main.js: the source is not a module`,
											pluginId: id,
										}),
									)
								: Effect.succeed((options.moduleFor ?? moduleOf)(id, text)),
					},
					hostFor: (pluginId, scope) => makeHost(registries, pluginId, scope),
					timeout: Duration.millis(200),
				});
			}),
		activate: (prepared) =>
			// The setup half, split from the acquire half so a reload can close
			// the old instance between the two.
			Effect.suspend(() => {
				trace.push(`setup:${prepared.manifest.id}`);
				return activatePlugin(prepared, Duration.millis(200));
			}),
		unload: (loaded) =>
			unloadPlugin(loaded).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						unloads.push(loaded.manifest.id);
						trace.push(`unload:${loaded.manifest.id}`);
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
		entrySources,
		trace,
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

	test("refuses a files record with no plugin.json, naming the missing file", async () => {
		// Regression: the store used to `JSON.parse` an absent manifest's empty
		// string first, so this reported `not valid JSON` and the loader's
		// clearer "carries no plugin.json" was unreachable through the store.
		const h = makeHarness();
		h.store.start();

		h.store.installFromText("", { "main.js": "export default { setup() {} }" });
		await tick();

		const text = h.store.getPlugins().notice?.text ?? "";
		expect(h.store.getPlugins().notice?.ok).toBe(false);
		expect(text).toContain("carries no");
		expect(text).toContain(MANIFEST_FILE);
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

describe("reload", () => {
	/** Bring one plugin up and return its live contribution list. */
	const bringUp = async (
		h: Harness,
		id = "t18.fixture",
	): Promise<{
		readonly entries: () => readonly { readonly owner: string }[];
	}> => {
		h.store.start();
		h.store.installFromText("", filesOf(id === "t18.fixture" ? {} : { id }));
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled(id, true);
		await tick();
		return { entries: () => Effect.runSync(h.registries.ui.entries()) };
	};

	test("reload validates the new source before it closes the old instance", async () => {
		const h = makeHarness();
		const { entries } = await bringUp(h);
		const first = entries()[0];
		expect(first).toBeDefined();
		expect(h.trace).toEqual(["load:t18.fixture", "setup:t18.fixture"]);

		h.entrySources.set("t18.fixture", "export default { setup() {} } /* v2 */");
		h.store.reload("t18.fixture");
		await tick();

		expect(only(h.store).status).toBe("loaded");
		// Two-phase: the new source is acquired and imported, then the old
		// instance's scope is closed, and only then does the new `setup` run — so
		// the old dispose cannot undo the new setup's own application.
		expect(h.trace).toEqual([
			"load:t18.fixture",
			"setup:t18.fixture",
			"load:t18.fixture",
			"unload:t18.fixture",
			"setup:t18.fixture",
		]);
		const after = entries();
		expect(after.length).toBe(1);
		expect(after[0]).not.toBe(first);
	});

	test("a reload whose new setup applies state survives the old instance's disposal", async () => {
		// A plugin whose `setup` mutates shared imperative state and whose
		// returned handle retracts it — the shape of T19's `theme-solarized`
		// example (a document class). If the old `dispose` runs after the new
		// `setup`, it retracts what the new instance just applied.
		let applied: string | undefined;
		const h = makeHarness({
			moduleFor: (_id, text) => ({
				setup: () => {
					applied = text.includes("v2") ? "v2" : "v1";
					return {
						dispose: () => {
							applied = undefined;
						},
					};
				},
			}),
		});
		await bringUp(h);
		expect(applied).toBe("v1");

		h.entrySources.set("t18.fixture", "export default {} /* v2 */");
		h.store.reload("t18.fixture");
		await tick();

		// The new instance's application is what survives, not the old dispose's
		// retraction: the ordering is acquire → close old → new setup.
		expect(only(h.store).status).toBe("loaded");
		expect(applied).toBe("v2");
	});

	test("a reload whose new setup throws leaves nothing loaded, not a silent empty id", async () => {
		// The new `setup` registers a contribution and then throws. Recording the
		// registration by identity means the failed scope's finalizer removes the
		// new entry, so the id is silently empty — and under the old swap the row
		// still read `loaded` over that empty registry. With the two-phase order
		// the old instance is already closed, so the honest result is nothing
		// loaded and `status: "failed"`.
		const h = makeHarness({
			moduleFor: (id, text) =>
				text.includes("THROWS")
					? {
							setup: (host) => {
								host.ui.register({
									id: `marker.${id}`,
									slot: "app.header.actions",
									component: () => null,
								});
								throw new Error("boom");
							},
						}
					: moduleOf(id),
		});
		const { entries } = await bringUp(h);
		expect(entries().length).toBe(1);

		h.entrySources.set("t18.fixture", "export default {} /* THROWS */");
		h.store.reload("t18.fixture");
		await tick();

		const plugin = only(h.store);
		// No stale entry survives under the id, and no failure is hidden behind a
		// `loaded` status: the row says what the registry shows.
		expect(entries()).toEqual([]);
		expect(plugin.status).toBe("failed");
		expect(plugin.error ?? "").toContain("boom");
	});

	test("a reload asked for while the plugin is mid-step is not dropped", async () => {
		// A watcher event can arrive while the settle loop is mid-step on the very
		// plugin it names. Asking for the reload from inside that step's own
		// `setup` is the deterministic shape of that race: `entry.pending` is set,
		// so a `pending` guard would discard the request entirely. It must instead
		// be recorded and applied once the step settles.
		let store: PluginsStore | undefined;
		let requested = false;
		const h = makeHarness({
			moduleFor: (id, text) =>
				text.includes("TRIGGER") && !requested
					? {
							setup: () => {
								requested = true;
								store?.reload(id);
							},
						}
					: moduleOf(id),
		});
		store = h.store;
		h.entrySources.set("t18.fixture", "export default {} /* TRIGGER */");
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();

		// The initial load ran, asked for a reload from inside its own setup, and
		// the reload was applied rather than dropped.
		expect(h.loads.filter((id) => id === "t18.fixture").length).toBe(2);
		expect(only(h.store).status).toBe("loaded");
	});

	test("a reload whose new source is invalid keeps the old version loaded, registered and working", async () => {
		const h = makeHarness();
		const { entries } = await bringUp(h);
		const first = entries()[0];
		expect(entries().length).toBe(1);

		h.entrySources.set("t18.fixture", "BROKEN — this is not a module");
		h.store.reload("t18.fixture");
		await tick();

		const plugin = only(h.store);
		// Still up, still registered, and the reason the reload failed is reported.
		expect(plugin.status).toBe("loaded");
		expect(plugin.error ?? "").toContain("failed to import");
		// The old scope was never closed, and the live contribution is the very
		// same object — not a replacement, not nothing.
		expect(h.unloads).toEqual([]);
		const after = entries();
		expect(after.length).toBe(1);
		expect(after[0]).toBe(first);
		expect(
			getLogSnapshot()
				.map((entry) => entry.message)
				.join("\n"),
		).toContain("reload failed");
	});

	test("a failed reload leaves every other plugin untouched", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		h.store.installFromText("", filesOf({ id: "t18.other", name: "Other" }));
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		h.store.setPluginEnabled("t18.other", true);
		await tick();

		const owners = (): readonly string[] =>
			Effect.runSync(h.registries.ui.entries()).map((entry) => entry.owner);
		expect([...owners()].sort()).toEqual(["t18.fixture", "t18.other"]);

		h.entrySources.set("t18.fixture", "BROKEN");
		h.store.reload("t18.fixture");
		await tick();

		const byId = new Map(
			h.store.getPlugins().plugins.map((plugin) => [plugin.state.id, plugin]),
		);
		expect(byId.get("t18.fixture")?.status).toBe("loaded");
		expect(byId.get("t18.other")?.status).toBe("loaded");
		expect([...owners()].sort()).toEqual(["t18.fixture", "t18.other"]);
		// Nothing was unloaded, not even the plugin whose reload failed.
		expect(h.unloads).toEqual([]);
	});

	test("reloadAll reloads every installed plugin in one pass", async () => {
		const h = makeHarness();
		h.store.start();
		h.store.installFromText("", filesOf());
		h.store.installFromText("", filesOf({ id: "t18.other", name: "Other" }));
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		h.store.setPluginEnabled("t18.other", true);
		await tick();
		expect(h.trace).toEqual([
			"load:t18.fixture",
			"setup:t18.fixture",
			"load:t18.other",
			"setup:t18.other",
		]);

		h.store.reloadAll();
		await tick();

		// Each plugin gets exactly one fresh load and one old-scope close.
		expect(h.loads.filter((id) => id === "t18.fixture").length).toBe(2);
		expect(h.loads.filter((id) => id === "t18.other").length).toBe(2);
		expect([...h.unloads].sort()).toEqual(["t18.fixture", "t18.other"]);
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(2);
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
	test("an uninstall that lands while a reload prepares the same plugin leaves no ghost", async () => {
		// `uninstall` runs on its own fiber, so it can delete the entry while the
		// settle loop is mid-`prepare` for that same plugin's reload. The reload
		// must then not `activate` the prepared scope: the store would no longer
		// track it, so its contributions would stay registered until the app
		// exits — a ghost plugin. The interleave is the harness's own `onLoad`
		// seam (fired inside `prepare`, before it resolves), not a timer.
		let store: PluginsStore | undefined;
		let armed = false;
		const h = makeHarness({
			onLoad: (id) => {
				if (!armed) return;
				armed = false;
				store?.uninstall(id);
			},
		});
		store = h.store;
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(1);

		armed = true;
		h.store.reload("t18.fixture");
		await tick();

		// The plugin was uninstalled, so the store tracks nothing for it — and
		// nothing may stay registered: the prepared scope never activated.
		expect(h.store.getPlugins().plugins).toEqual([]);
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);
	});

	test("an uninstall that lands while the initial load prepares the same plugin leaves no ghost", async () => {
		// The same window as the reload case, on the ordinary load path:
		// `loadStep` prepares the source, then activates it, and `uninstall` can
		// delete the entry in between. Activating then registers into a scope the
		// store will never close. Same seam as the reload race.
		let store: PluginsStore | undefined;
		let armed = false;
		const h = makeHarness({
			onLoad: (id) => {
				if (!armed) return;
				armed = false;
				store?.uninstall(id);
			},
		});
		store = h.store;
		h.store.start();
		h.store.installFromText("", filesOf());
		await tick();

		armed = true;
		h.store.setPluginsEnabled(true);
		h.store.setPluginEnabled("t18.fixture", true);
		await tick();

		expect(h.store.getPlugins().plugins).toEqual([]);
		expect(Effect.runSync(h.registries.ui.entries())).toEqual([]);
	});

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

describe("the URL fetch bound", () => {
	test("refuses a declared body only when it exceeds the source limit", () => {
		expect(declaredBodyOverLimit(null)).toBe(false);
		expect(declaredBodyOverLimit(String(PLUGIN_SOURCE_MAX_CHARS))).toBe(false);
		expect(declaredBodyOverLimit(String(PLUGIN_SOURCE_MAX_CHARS + 1))).toBe(
			true,
		);
		expect(declaredBodyOverLimit("not a number")).toBe(false);
		expect(declaredBodyOverLimit("")).toBe(false);
	});
});

describe("the settle loop", () => {
	test("no enabled plugin is stranded when the round bound is reached", async () => {
		// Drive the bound: each plugin's load enables the next, so every round
		// absorbs exactly one new decision and `MAX_SETTLE_ROUNDS` rounds leave
		// the last plugin planned but never run. Recording a decision when it is
		// *planned* (rather than when its step runs) would mark that last plugin
		// as already tried, so no later settings change could ever retry it.
		const ids = Array.from(
			{ length: MAX_SETTLE_ROUNDS + 1 },
			(_, index) => `t18.chain-${index}`,
		);
		let store: PluginsStore | undefined;
		const h = makeHarness({
			extraManifests: ids.map((id) => manifestOf({ id, name: id })),
			initialSettings: {
				...settingsDefaults(),
				pluginsEnabled: true,
				plugins: ids.map((id) => ({
					id,
					enabled: false,
					version: "1.0.0",
					capabilities: ["net"],
					data: {},
				})),
			},
			onLoad: (id) => {
				const next = ids[ids.indexOf(id) + 1];
				if (next !== undefined) store?.setPluginEnabled(next, true);
			},
		});
		store = h.store;
		h.store.start();
		await tick();
		await tick();

		// The chain: enabling the first loads it, and that load enables the next.
		h.store.setPluginEnabled(ids[0] ?? "", true);
		await tick();
		await tick();

		const status = (id: string): string | undefined =>
			h.store.getPlugins().plugins.find((plugin) => plugin.state.id === id)
				?.status;

		// One settings change that touches no plugin's own persisted state — the
		// gesture the log line promised would retry. Under the bug the stranded
		// plugin is skipped by it anyway.
		h.store.setPluginsEnabled(true);
		await tick();
		await tick();

		// One array assertion, so a failure names every plugin's status at once.
		expect(ids.map(status)).toEqual(ids.map(() => "loaded"));
		expect(Effect.runSync(h.registries.ui.entries()).length).toBe(ids.length);
	});
});
