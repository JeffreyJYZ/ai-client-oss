import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Settings, settingsDefaults } from "@lib/db";
import { BUILTIN_AREAS, type BuiltinArea } from "@lib/plugins/areas";
import { makeBuiltinsReconciler } from "@lib/plugins/builtin";
import {
	BUILTIN_IDENTITIES,
	LOCKED_BUILTIN_IDS,
} from "@lib/plugins/builtinIdentity";
import { PluginFault } from "@lib/plugins/errors";
import {
	type Host,
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { Cause, Effect, Exit, Scope } from "effect";
import {
	type BuiltinsDeps,
	type BuiltinsSnapshot,
	type BuiltinsStore,
	getBuiltinsSnapshot,
	makeBuiltinsStore,
	startBuiltins,
} from "@/state/builtins";

/**
 * The built-in store's semantics. No DOM: the store is a module snapshot plus a
 * listener set, driven directly (the `state/plugins.test.ts` shape). The
 * settings seam is injected, so nothing here touches IndexedDB or React — but
 * the write half **mirrors `@/state/settings.ts`**: the merged object is
 * validated by the real `Settings` schema before it lands, which is what makes
 * "round-trips through the settings write seam" a claim about the schema rather
 * than about a fake's own bookkeeping.
 */

// The plugin log is a module-level buffer (the section's panel reads it), so a
// line from one test would otherwise be visible to the next.
beforeEach(() => {
	clearLog();
});

interface Harness {
	readonly store: BuiltinsStore;
	readonly settings: () => Settings;
	/** The store's own view, for the identity assertions. */
	readonly snapshot: () => BuiltinsSnapshot;
	/** Every patch the store handed the settings seam, in order. */
	readonly patches: readonly Partial<Settings>[];
	/** Write settings the way any other part of the app does. */
	readonly write: (patch: Partial<Settings>) => void;
	readonly notifications: () => number;
	/** How many times the store subscribed to settings — a start count. */
	readonly subscriptions: () => number;
}

const makeHarness = (initial: Settings = settingsDefaults()): Harness => {
	let settings = initial;
	const listeners = new Set<() => void>();
	const patches: Partial<Settings>[] = [];
	let notifications = 0;
	let subscriptions = 0;

	const write = (patch: Partial<Settings>): void => {
		patches.push(patch);
		const parsed = Settings.safeParse({ ...settings, ...patch });
		if (!parsed.success) return;
		settings = parsed.data;
		notifications += 1;
		for (const listener of listeners) listener();
	};

	const deps: BuiltinsDeps = {
		readSettings: () => settings,
		writeSettings: write,
		subscribeSettings: (listener) => {
			subscriptions += 1;
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	const store = makeBuiltinsStore(deps);

	return {
		store,
		settings: () => settings,
		snapshot: store.getBuiltinsSnapshot,
		patches,
		write,
		notifications: () => notifications,
		subscriptions: () => subscriptions,
	};
};

/** Settings carrying a `builtins` field, decoded by the real schema. */
const withBuiltins = (builtins: NonNullable<Settings["builtins"]>): Settings =>
	Settings.parse({ builtins });

/** The last line the store logged. */
const lastLog = (): string => getLogSnapshot().at(-1)?.message ?? "";

describe("defaults and unknown ids", () => {
	test("an absent builtins field means every area and contribution is on", () => {
		const h = makeHarness();
		h.store.start();

		const snapshot = h.store.getBuiltinsSnapshot();
		for (const area of BUILTIN_IDENTITIES) {
			expect(snapshot.builtins[area.id]).toBe(true);
		}
		expect(snapshot.contributions).toEqual({});
		// Migration-free in both directions: nothing was written, so an older app
		// opening this data sees exactly the blob it wrote.
		expect(h.settings().builtins).toBeUndefined();
		expect(h.patches).toEqual([]);
	});

	test("an unknown area id is ignored, refused, and never stored", () => {
		const h = makeHarness(
			withBuiltins({
				"app.renamed-away": { enabled: false },
				"app.shell": { enabled: false },
			}),
		);
		h.store.start();

		// Ignored: no snapshot entry, and the known area keeps the state it has.
		expect(
			h.store.getBuiltinsSnapshot().builtins["app.renamed-away"],
		).toBeUndefined();
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(false);

		// A toggle for it is refused rather than inventing a key.
		h.store.setBuiltinEnabled("app.renamed-away", true);
		expect(lastLog()).toContain("app.renamed-away");
		expect(h.patches).toEqual([]);
	});

	test("an unknown contribution id is ignored, and is not migrated or deleted", () => {
		const h = makeHarness(
			withBuiltins({
				"app.renamed-away": { enabled: false },
				"app.tools": {
					enabled: false,
					contributions: { "renamed-contribution": false },
				},
			}),
		);
		h.store.start();

		// Ignored, not interpreted: the store has no contribution allowlist (the
		// registries hold the ids), so the resolved view carries the stale id and
		// nothing else — Task 4's registration filter is what makes it inert,
		// because an id nothing registers matches nothing to skip.
		expect(h.store.getBuiltinsSnapshot().contributions).toEqual({
			"app.tools": { "renamed-contribution": false },
		});
		expect(h.settings().builtins?.["app.tools"]?.contributions).toEqual({
			"renamed-contribution": false,
		});

		// A later write for the same area keeps both stale entries: nothing is
		// migrated, and nothing is pruned out from under an older app.
		h.store.setBuiltinEnabled("app.tools", true);
		expect(h.settings().builtins?.["app.tools"]?.enabled).toBe(true);
		expect(h.settings().builtins?.["app.tools"]?.contributions).toEqual({
			"renamed-contribution": false,
		});
		expect(h.settings().builtins?.["app.renamed-away"]).toEqual({
			enabled: false,
		});
	});
});

describe("the locked core", () => {
	test("the locked set is the substrate and the manager — pinned literally", () => {
		// A literal, not a re-derivation: recomputing `LOCKED_BUILTIN_IDS` from
		// `BUILTIN_IDENTITIES` would compare an expression with itself, so a third
		// locked area could appear silently.
		expect(LOCKED_BUILTIN_IDS).toEqual(["app.substrate", "app.builtins"]);
	});

	test("a locked area refuses to be disabled, and the refusal names it", () => {
		const h = makeHarness();
		h.store.start();

		for (const id of ["app.substrate", "app.builtins"]) {
			h.store.setBuiltinEnabled(id, false);
			expect(lastLog()).toContain(id);
			expect(lastLog()).toContain("locked");
		}

		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.builtins["app.substrate"]).toBe(true);
		expect(snapshot.builtins["app.builtins"]).toBe(true);
		// Refused means refused: nothing was persisted.
		expect(h.patches).toEqual([]);
	});
});

describe("the presets", () => {
	test("the bare preset disables every non-locked area and leaves every locked one on", () => {
		const h = makeHarness(
			withBuiltins({
				"app.tools": { enabled: false, contributions: { fetch_url: false } },
			}),
		);
		h.store.start();

		h.store.applyBarePreset();

		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.builtins["app.substrate"]).toBe(true);
		expect(snapshot.builtins["app.builtins"]).toBe(true);
		expect(snapshot.builtins["app.shell"]).toBe(false);
		expect(snapshot.builtins["app.tools"]).toBe(false);
		for (const area of BUILTIN_IDENTITIES) {
			expect(snapshot.builtins[area.id]).toBe(area.locked === true);
		}

		// The preset writes the area flags it decided, and keeps the drill-down.
		expect(h.settings().builtins?.["app.substrate"]?.enabled).toBe(true);
		expect(h.settings().builtins?.["app.builtins"]?.enabled).toBe(true);
		expect(h.settings().builtins?.["app.shell"]?.enabled).toBe(false);
		expect(snapshot.contributions["app.tools"]?.fetch_url).toBe(false);
	});

	test("a preset leaves an entry no area claims exactly as it found it", () => {
		// Written by a *newer* app version, or left by a renamed area. The store
		// must neither act on it nor rewrite it (spec "Persistence": unknown ids
		// are ignored, which is what makes the field forward-compatible).
		const stale = { enabled: false, contributions: { "old-tool": true } };
		const h = makeHarness(
			withBuiltins({
				"app.migrated-away": stale,
				"app.tools": { enabled: false, contributions: { fetch_url: false } },
			}),
		);
		h.store.start();

		h.store.applyBarePreset();
		expect(h.settings().builtins?.["app.migrated-away"]).toEqual(stale);

		h.store.restoreAllBuiltins();
		expect(h.settings().builtins?.["app.migrated-away"]).toEqual(stale);
		expect(JSON.stringify(h.settings().builtins?.["app.migrated-away"])).toBe(
			JSON.stringify(stale),
		);

		// The areas the store does own were acted on.
		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.builtins["app.shell"]).toBe(true);
		expect(snapshot.contributions["app.tools"]?.fetch_url).toBe(true);
	});

	test("restore-all re-enables every area and every contribution", () => {
		const h = makeHarness(
			withBuiltins({
				"app.tools": { enabled: false, contributions: { fetch_url: false } },
			}),
		);
		h.store.start();

		h.store.applyBarePreset();
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(false);

		h.store.restoreAllBuiltins();

		const snapshot = h.store.getBuiltinsSnapshot();
		for (const area of BUILTIN_IDENTITIES) {
			expect(snapshot.builtins[area.id]).toBe(true);
		}
		expect(snapshot.builtins["app.shell"]).toBe(true);
		expect(snapshot.contributions["app.tools"]?.fetch_url).toBe(true);
		// Re-enabled, not deleted: the recorded override is still in the store.
		expect(h.settings().builtins?.["app.tools"]?.contributions).toEqual({
			fetch_url: true,
		});
	});
});

describe("toggles through the settings seam", () => {
	test("an area toggle round-trips through the settings write seam", () => {
		const h = makeHarness();
		h.store.start();

		h.store.setBuiltinEnabled("app.shell", false);

		expect(h.patches).toHaveLength(1);
		expect(h.patches[0]?.builtins?.["app.shell"]?.enabled).toBe(false);
		// What landed is the schema-validated settings, read back off the seam.
		expect(h.settings().builtins?.["app.shell"]?.enabled).toBe(false);
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(false);

		h.store.setBuiltinEnabled("app.shell", true);
		expect(h.settings().builtins?.["app.shell"]?.enabled).toBe(true);
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(true);
	});

	test("a contribution toggle round-trips and leaves its area alone", () => {
		const h = makeHarness();
		h.store.start();

		h.store.setContributionEnabled("app.tools", "fetch_url", false);

		expect(h.settings().builtins?.["app.tools"]?.contributions).toEqual({
			fetch_url: false,
		});
		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.contributions["app.tools"]?.fetch_url).toBe(false);
		expect(snapshot.builtins["app.tools"]).toBe(true);
	});

	test("a contribution of a locked area refuses to be disabled, and names it", () => {
		const h = makeHarness();
		h.store.start();

		h.store.setContributionEnabled(
			"app.builtins",
			"settings.section.plugins",
			false,
		);
		expect(lastLog()).toContain("app.builtins");
		expect(h.settings().builtins).toBeUndefined();
		expect(h.patches).toEqual([]);
	});
});

describe("the snapshot React reads", () => {
	test("start() latches, so a second call cannot double-subscribe", () => {
		const h = makeHarness(withBuiltins({ "app.shell": { enabled: false } }));
		h.store.start();
		h.store.start();

		expect(h.subscriptions()).toBe(1);
		// The one subscription is live, not just counted.
		h.write({ pluginsEnabled: true });
		expect(h.snapshot().enabled).toBe(true);
	});

	test("the module's own door is reachable and idempotent", () => {
		// The real store, not a harness: the module starts itself at import, and
		// Task 3's boot may call this too — so it must be safe to call more than
		// once, and the resolved state must cover every identity.
		startBuiltins();
		startBuiltins();

		expect(Object.keys(getBuiltinsSnapshot().builtins)).toHaveLength(
			BUILTIN_IDENTITIES.length,
		);
	});

	test("is resolved before `start()`, and a toggle works without it", () => {
		const h = makeHarness(withBuiltins({ "app.shell": { enabled: false } }));

		// No `start()`: a store still answers with the settings it has.
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(false);
		h.store.setBuiltinEnabled("app.shell", true);
		expect(h.store.getBuiltinsSnapshot().builtins["app.shell"]).toBe(true);
	});

	test("is referentially stable between changes", () => {
		// `useSyncExternalStore` compares `getSnapshot()` by identity on every
		// render: a fresh object per read is an infinite render loop.
		const h = makeHarness();
		h.store.start();

		const first = h.store.getBuiltinsSnapshot();
		expect(h.snapshot()).toBe(first);

		// A write that resolves to the same state, and a refused write, both keep
		// the very object React already holds.
		h.store.setBuiltinEnabled("app.shell", true);
		expect(h.snapshot()).toBe(first);
		h.store.setBuiltinEnabled("app.unknown-area", false);
		expect(h.snapshot()).toBe(first);
		// A settings change from elsewhere, with no built-in consequence either.
		h.write({ memoriesEnabled: false });
		expect(h.snapshot()).toBe(first);

		// A real change replaces it exactly once.
		h.store.setBuiltinEnabled("app.shell", false);
		const second = h.store.getBuiltinsSnapshot();
		expect(second).not.toBe(first);
		expect(second.builtins["app.shell"]).toBe(false);
	});

	test("notifies subscribers once per real change", () => {
		const h = makeHarness();
		h.store.start();
		const seen: boolean[] = [];
		const unsubscribe = h.store.subscribe(() => {
			seen.push(h.store.getBuiltinsSnapshot().builtins["app.shell"] === false);
		});

		h.store.setBuiltinEnabled("app.shell", false);
		expect(seen).toEqual([true]);

		// A refused toggle and a no-op write are not changes.
		h.store.setBuiltinEnabled("app.builtins", false);
		h.store.setBuiltinEnabled("app.shell", false);
		expect(seen).toEqual([true]);

		unsubscribe();
		h.store.setBuiltinEnabled("app.shell", true);
		expect(seen).toEqual([true]);
	});

	test("the master switch is read through, not applied to the built-ins", () => {
		const h = makeHarness();
		h.store.start();
		expect(h.store.getBuiltinsSnapshot().enabled).toBe(false);

		h.write({ pluginsEnabled: true });
		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.enabled).toBe(true);
		// The switch gates *installed* plugins only: every built-in stays on.
		for (const area of BUILTIN_IDENTITIES) {
			expect(snapshot.builtins[area.id]).toBe(true);
		}

		h.write({ pluginsEnabled: false });
		expect(h.store.getBuiltinsSnapshot().enabled).toBe(false);
	});
});

/* ----------------------------------------------------------------- reconcile */

/**
 * Task 3's integration tests: the real `makeBuiltinsReconciler`, the real
 * `BUILTIN_AREAS` (so the registrars under `builtin/**` actually run), the real
 * `makeHost` over a real `HostLayer`, and the real registries — only the
 * enabled-state source is a harness, so nothing here is exercised against a
 * fake of the thing under test.
 *
 * The tests read the registries by id rather than by owner: `registry.add`
 * replaces an entry with the same id **in place**, so an id set is what the
 * reconcile actually controls. The "off empties it" half of the toggle test is
 * therefore load-bearing — a reconcile that registered without closing would
 * leave the ids standing and fail it.
 */

/** The registries a built-in area can register into, as this test reads them. */
const REGISTRIES = ["ui", "commands", "tools", "providers", "themes"] as const;
type RegistryName = (typeof REGISTRIES)[number];
type RegistryIds = Readonly<Record<RegistryName, readonly string[]>>;

type Reconciler = ReturnType<typeof makeBuiltinsReconciler>;

/** A fresh set of the layer's registries and theme core, per test. */
const makeServices = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const idsOf = (entries: readonly { readonly id: string }[]): string[] =>
	entries.map((entry) => entry.id);

/** Every relevant registry's ids, in resolution order. */
const registryIds = (services: HostServicesShape): RegistryIds => ({
	ui: idsOf(Effect.runSync(services.ui.entries())),
	commands: idsOf(Effect.runSync(services.commands.entries())),
	tools: idsOf(Effect.runSync(services.tools.entries())),
	providers: idsOf(Effect.runSync(services.providers.entries())),
	themes: idsOf(Effect.runSync(services.themes.entries())),
});

/**
 * The enabled-state source one reconciler reads. Mutable on purpose: the same
 * reconciler instance reconciles across many states, so its close-first half is
 * the one under test (a second instance would close nothing).
 */
const makeEnabled = () => {
	const disabled = new Set<string>();
	// Contribution-level state, per area. Absent means on, the store's own rule.
	const disabledContributions = new Map<string, Set<string>>();
	return {
		enabledOf: (id: string): boolean => !disabled.has(id),
		/** The store's rule, over injected seams: on unless explicitly `false`. */
		contributionEnabledOf: (areaId: string, contributionId: string): boolean =>
			disabledContributions.get(areaId)?.has(contributionId) !== true,
		set: (id: string, on: boolean): void => {
			if (on) disabled.delete(id);
			else disabled.add(id);
		},
		setContribution: (
			areaId: string,
			contributionId: string,
			on: boolean,
		): void => {
			const set = disabledContributions.get(areaId) ?? new Set<string>();
			if (on) set.delete(contributionId);
			else set.add(contributionId);
			disabledContributions.set(areaId, set);
		},
		/** Everything off except `id`. */
		only: (id: string): void => {
			disabled.clear();
			for (const area of BUILTIN_AREAS) {
				if (area.id !== id) disabled.add(area.id);
			}
		},
		all: (): void => {
			disabled.clear();
		},
	};
};

const run = (
	reconciler: Reconciler,
	services: HostServicesShape,
): Promise<void> => Effect.runPromise(reconciler.reconcile(services));

describe("reconcile", () => {
	test("with everything on, every area's contributions are registered", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, services);
		const all = registryIds(services);

		// Every toggleable area contributes something; the locked core registers
		// nothing of its own in this task. Read each area alone, through the same
		// reconciler, and union the results.
		const union: Record<RegistryName, Set<string>> = {
			ui: new Set(),
			commands: new Set(),
			tools: new Set(),
			providers: new Set(),
			themes: new Set(),
		};
		for (const area of BUILTIN_AREAS) {
			enabled.only(area.id);
			await run(reconciler, services);
			const alone = registryIds(services);
			const seen = REGISTRIES.flatMap((name) => alone[name]);
			if (area.locked === true) {
				expect(
					seen,
					`${area.id} is locked and registers nothing of its own`,
				).toEqual([]);
			} else {
				expect(
					seen.length,
					`${area.id} contributes at least one entry`,
				).toBeGreaterThan(0);
			}
			for (const name of REGISTRIES) {
				for (const id of alone[name]) union[name].add(id);
			}
		}

		enabled.all();
		await run(reconciler, services);
		const registered = registryIds(services);

		// Everything on holds exactly the union of what each area contributes.
		for (const name of REGISTRIES) {
			expect(new Set(registered[name]), `${name} ids`).toEqual(union[name]);
			expect(registered[name].length, `${name} count`).toBe(all[name].length);
		}

		// Concrete anchors, one per registry the app's own areas fill.
		expect(registered.ui).toContain("ui.root.layout");
		expect(registered.tools).toEqual(["fetch_url", "web_search"]);
		expect(registered.providers).toEqual(
			expect.arrayContaining(["anthropic", "responses", "chatcompletions"]),
		);
		expect(registered.themes).toEqual(["app.theme.dark"]);
		expect(registered.commands).toContain("app.command.palette");
	});

	test("disabling one area empties exactly that area's registrations", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, services);
		const all = registryIds(services);

		// Guard against a vacuous pass: the additivity below (left + alone = all)
		// would hold trivially if everything registered nothing. Every registry
		// has entries with everything on, so there is something to remove.
		for (const name of REGISTRIES) {
			expect(all[name].length, `${name} has entries to remove`).toBeGreaterThan(
				0,
			);
		}

		for (const area of BUILTIN_AREAS) {
			enabled.only(area.id);
			await run(reconciler, services);
			const alone = registryIds(services);

			// Each toggleable area contributes something, so "what that area
			// alone contributes" is a real remainder, not an empty set.
			if (area.locked !== true) {
				expect(
					REGISTRIES.flatMap((name) => alone[name]).length,
					`${area.id} contributes something to remove`,
				).toBeGreaterThan(0);
			}

			enabled.all();
			enabled.set(area.id, false);
			await run(reconciler, services);
			const without = registryIds(services);

			for (const name of REGISTRIES) {
				// What is left plus what that one area contributes is everything,
				// with no overlap: disabling it removed exactly its own entries and
				// touched no other area's.
				expect(
					without[name].length + alone[name].length,
					`${area.id} in ${name}: sizes add`,
				).toBe(all[name].length);
				expect(
					new Set([...without[name], ...alone[name]]),
					`${area.id} in ${name}: union is everything`,
				).toEqual(new Set(all[name]));
			}
		}

		// The direct case, for the smallest surface: disabling tools empties the
		// tools registry and leaves `ui` untouched.
		enabled.all();
		enabled.set("app.tools", false);
		await run(reconciler, services);
		const direct = registryIds(services);
		expect(direct.tools).toEqual([]);
		expect(direct.ui).toEqual(all.ui);
	});

	test("off → on → off → on leaves no duplicates", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, services);
		const baseline = registryIds(services);

		const logged = spyOn(console, "log");
		try {
			enabled.set("app.tools", false);
			await run(reconciler, services);
			expect(registryIds(services).tools, "off empties the area").toEqual([]);

			enabled.set("app.tools", true);
			await run(reconciler, services);
			expect(registryIds(services), "on restores it exactly").toEqual(baseline);

			enabled.set("app.tools", false);
			await run(reconciler, services);
			expect(registryIds(services).tools, "off again empties it").toEqual([]);

			enabled.set("app.tools", true);
			await run(reconciler, services);
			expect(registryIds(services), "on again restores it exactly").toEqual(
				baseline,
			);
		} finally {
			logged.mockRestore();
		}

		// One live scope per enabled area, not one per toggle: every scope the
		// previous reconcile opened was closed.
		expect(reconciler.live().length).toBe(BUILTIN_AREAS.length);

		// A reconcile that registered over a live registration makes the registry
		// log a refusal ("already holds a contribution" / "already registered" /
		// "already bound"); the cycle logged none.
		const faults = logged.mock.calls
			.flat()
			.filter((value): value is PluginFault => value instanceof PluginFault)
			.map((fault) => fault.detail);
		expect(faults.filter((detail) => detail.includes("already"))).toEqual([]);
	});

	test("a register that throws leaves the previous registrations intact", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		let failing = false;

		// The real table, with the tools area swapped for one that registers a
		// contribution and then throws when `failing` — the "registered
		// something, then broke" state the rollback must undo.
		const areas: readonly BuiltinArea[] = BUILTIN_AREAS.map((area) =>
			area.id !== "app.tools"
				? area
				: {
						...area,
						register: (host: Host): void => {
							if (!failing) {
								area.register(host);
								return;
							}
							host.ui.register({
								id: "test.partial",
								slot: "app.header.actions",
								component: () => null,
							});
							throw new Error("boom");
						},
					},
		);

		const reconciler = makeBuiltinsReconciler({
			areas,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});
		enabled.all();
		await run(reconciler, services);
		const baseline = registryIds(services);
		expect(baseline.tools).toEqual(["fetch_url", "web_search"]);

		clearLog();
		failing = true;
		await run(reconciler, services);

		const after = registryIds(services);
		// The failed area registered nothing: its one partial contribution was
		// rolled back with its scope rather than left behind.
		expect(after.tools).toEqual([]);
		expect(after.ui).not.toContain("test.partial");
		// Every other area is intact.
		expect(after.ui).toEqual(baseline.ui);
		expect(after.commands).toEqual(baseline.commands);
		expect(after.providers).toEqual(baseline.providers);
		expect(after.themes).toEqual(baseline.themes);

		// The failure named the area it belonged to.
		const messages = getLogSnapshot()
			.map((entry) => entry.message)
			.join("\n");
		expect(messages).toContain("app.tools");
	});

	test("toggling app.themes repeatedly keeps exactly one live subscription", async () => {
		const base = makeServices();
		// Count the theme-reconciliation subscriptions that are live. The
		// service's own `run` is the work each registration starts; the tracker
		// decrements when that work ends, whether by completion or by the
		// interruption a scope close performs. A registrar that starts it with a
		// bare `Effect.runFork` earns no decrement, so this count grows by one
		// per registration — which is exactly the accumulation under test.
		let liveSubscriptions = 0;
		const tracked: HostServicesShape = {
			...base,
			themesService: {
				run: base.themesService.run,
				forPlugin: (themes) => {
					const facade = base.themesService.forPlugin(themes);
					return {
						...facade,
						run: () => {
							liveSubscriptions += 1;
							return facade.run().pipe(
								Effect.ensuring(
									Effect.sync(() => {
										liveSubscriptions -= 1;
									}),
								),
							);
						},
					};
				},
			},
		};

		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, tracked);
		expect(liveSubscriptions, "the first registration starts one").toBe(1);

		for (let cycle = 0; cycle < 3; cycle += 1) {
			enabled.set("app.themes", false);
			await run(reconciler, tracked);
			expect(liveSubscriptions, "off interrupts the subscription").toBe(0);

			enabled.set("app.themes", true);
			await run(reconciler, tracked);
			expect(liveSubscriptions, "on starts exactly one").toBe(1);
		}
	});

	test("a finalizer that throws is logged, not fatal to the reconcile", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const sabotaged = "app.overlay";

		// A real scope finalizer that throws, added to one area's scope the same
		// way the host adds its own (`Scope.addFinalizer`, provided the scope).
		// It is the defect the tear-down guard must absorb: unguarded, the next
		// reconcile's close dies and `runtime.runPromise` at boot rejects, which
		// is a blank app.
		const sabotagingMakeHost = (
			service: HostServicesShape,
			areaId: string,
			areaScope: Scope.Scope,
		): Host => {
			if (areaId === sabotaged) {
				Effect.runSync(
					Effect.provideService(
						Scope.addFinalizer(
							areaScope,
							Effect.die(new Error("finalizer boom")),
						),
						Scope.Scope,
						areaScope,
					),
				);
			}
			return makeHost(service, areaId, areaScope);
		};

		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost: sabotagingMakeHost,
		});

		enabled.all();
		await run(reconciler, services);
		const baseline = registryIds(services);

		clearLog();
		// The next reconcile closes that scope first. Unguarded, this rejects.
		await run(reconciler, services);

		const after = registryIds(services);
		// The loop continued: every area, the sabotaged one included, is live.
		expect(after.ui).toEqual(baseline.ui);
		expect(after.tools).toEqual(baseline.tools);
		expect(after.commands).toEqual(baseline.commands);

		// And the failure named the area whose teardown faulted.
		const messages = getLogSnapshot()
			.map((entry) => entry.message)
			.join("\n");
		expect(messages).toContain(sabotaged);
	});
});

/* ---------------------------------------------------- per-contribution toggles */

/**
 * Task 4's filter: the real reconciler over the real `BUILTIN_AREAS`, the real
 * `makeHost` and the real registries; only the enabled-state source — area and
 * contribution alike — is injected, exactly as the production wiring reads it
 * off the store.
 *
 * The assertions are written so that a **no-op filter** and an **area-level**
 * filter both fail: a no-op leaves the disabled id standing in the registry,
 * and an area-level filter empties the siblings each test requires to survive.
 */

describe("per-contribution toggles", () => {
	test("app.tools: disabling one tool leaves its sibling registered", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, services);
		expect(registryIds(services).tools).toEqual(["fetch_url", "web_search"]);

		enabled.setContribution("app.tools", "fetch_url", false);
		await run(reconciler, services);

		// `fetch_url` is not registered at all — off is indistinguishable from
		// never existed — and its sibling is untouched.
		expect(registryIds(services).tools).toEqual(["web_search"]);
	});

	test("a UI area: disabling one contribution leaves its siblings registered", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		await run(reconciler, services);
		const before = registryIds(services).ui;
		expect(before).toContain("shell.header.title");
		expect(before).toContain("ui.root.layout");

		enabled.setContribution("app.shell", "shell.header.title", false);
		await run(reconciler, services);
		const after = registryIds(services).ui;

		// Exactly one entry gone — every sibling of its own area, and every
		// other area's entry, still registered.
		expect(after).toEqual(before.filter((id) => id !== "shell.header.title"));
		expect(after).toContain("ui.root.layout");
		expect(after).toContain("shell.header.system-prompt");
		expect(after).toContain("composer.toolbar.attach");
	});

	test("a contribution toggle re-reconciles and registers the rest of the area", async () => {
		// The interaction: a contribution toggle changes the snapshot, which
		// triggers a full reconcile — and that reconcile must still register the
		// rest of the area, not empty it. Driven through the real store, whose
		// snapshot the deps read exactly as the production wiring does.
		const services = makeServices();
		const h = makeHarness();
		h.store.start();

		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => h.snapshot().builtins[areaId] === true,
			contributionEnabledOf: (areaId, contributionId) =>
				h.snapshot().contributions[areaId]?.[contributionId] !== false,
			makeHost,
		});

		await run(reconciler, services);
		const baseline = registryIds(services);

		h.store.setContributionEnabled("app.tools", "fetch_url", false);
		// The store really changed, so the app's subscription would reconcile.
		expect(h.snapshot().contributions["app.tools"]?.fetch_url).toBe(false);
		await run(reconciler, services);

		const after = registryIds(services);
		// The area is not emptied: its remaining tool is registered.
		expect(after.tools).toEqual(["web_search"]);
		// And nothing outside the area moved.
		expect(after.ui).toEqual(baseline.ui);
		expect(after.commands).toEqual(baseline.commands);
		expect(after.providers).toEqual(baseline.providers);
		expect(after.themes).toEqual(baseline.themes);
	});

	test("an unknown contribution id in stored state is ignored", async () => {
		const services = makeServices();
		const h = makeHarness(
			withBuiltins({
				"app.tools": {
					contributions: { "renamed-contribution": false },
				},
			}),
		);
		h.store.start();

		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => h.snapshot().builtins[areaId] === true,
			contributionEnabledOf: (areaId, contributionId) =>
				h.snapshot().contributions[areaId]?.[contributionId] !== false,
			makeHost,
		});

		await run(reconciler, services);

		// The stale id matches nothing to skip, so both tools register; no crash,
		// no effect. The stored state is left exactly as found (no migration).
		expect(registryIds(services).tools).toEqual(["fetch_url", "web_search"]);
		expect(h.settings().builtins?.["app.tools"]?.contributions).toEqual({
			"renamed-contribution": false,
		});
	});

	test("a close that is interrupted does not log a fault", async () => {
		// Parked item A: `closeQuietly` piped through `Effect.catchCause`, which
		// recovers interruptions too — so a cancelled reconcile logged a bogus
		// fault and could run to completion. Mirroring `host.run`, an interrupt
		// must be re-raised, never logged.
		const services = makeServices();
		const area: BuiltinArea = {
			id: "app.interrupt-test",
			label: "Interrupt test",
			description: "A test-only area whose teardown is an interruption.",
			locked: false,
			register: () => {},
		};

		// A finalizer that is a bare interruption: added to one area's scope the
		// same way the host adds its own, so the next close's cause is an
		// interrupt and nothing else — no timing to race.
		const interruptingMakeHost = (
			service: HostServicesShape,
			areaId: string,
			areaScope: Scope.Scope,
		): Host => {
			Effect.runSync(
				Effect.provideService(
					Scope.addFinalizer(areaScope, Effect.interrupt),
					Scope.Scope,
					areaScope,
				),
			);
			return makeHost(service, areaId, areaScope);
		};

		const reconciler = makeBuiltinsReconciler({
			areas: [area],
			enabledOf: () => true,
			contributionEnabledOf: () => true,
			makeHost: interruptingMakeHost,
		});

		await run(reconciler, services);
		clearLog();

		// The next reconcile closes the live scope first; that close is
		// interrupted, and the interrupt must propagate rather than be swallowed.
		const exit = await Effect.runPromiseExit(reconciler.reconcile(services));
		expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		expect(getLogSnapshot()).toEqual([]);
	});
});
