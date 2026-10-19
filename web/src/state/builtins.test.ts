import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Settings, settingsDefaults } from "@lib/db";
import {
	BUILTIN_AREAS,
	type BuiltinArea,
	type BuiltinId,
} from "@lib/plugins/areas";
import {
	areaEnabled,
	contributionEnabled,
	makeBuiltinsReconciler,
	makeCoalescingRunner,
} from "@lib/plugins/builtin";
import { MEMORY_TOOL_NAMES } from "@lib/plugins/builtin/memory";
import {
	BUILTIN_IDENTITIES,
	LOCKED_BUILTIN_IDS,
} from "@lib/plugins/builtinIdentity";
import { PluginFault } from "@lib/plugins/errors";
import {
	type Contribution,
	type Host,
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { Cause, Deferred, Effect, Exit, Scope } from "effect";
import {
	type BuiltinsDeps,
	type BuiltinsSnapshot,
	type BuiltinsStore,
	getBuiltinsSnapshot,
	makeBuiltinsStore,
	startBuiltins,
} from "@/state/builtins";
import { setSettings } from "@/state/settings";
import { minimalHostView } from "@/ui/MinimalHost";
import { BUILTIN_CONTRIBUTIONS } from "@/ui/plugins/BuiltinsArea";
import { PluginsSection } from "@/ui/plugins/PluginsSection";
import { SettingsShell } from "@/ui/Settings";

/**
 * The tools registry with everything on: the tools area's own two, then the
 * memory area's five, in `BUILTIN_AREAS` registration order. Derived from the
 * memory registrar's own name list, so this suite tests the reconciler rather
 * than re-typing (and being broken by) a renaming — the name pin is
 * `builtin/memory.test.ts`'s.
 */
const ALL_TOOLS: readonly string[] = [
	"fetch_url",
	"web_search",
	...MEMORY_TOOL_NAMES,
];

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
	// `app.memory` reads the real settings store (`appMemorySettings`); make the
	// assumption explicit rather than ambient so this suite is order-independent.
	setSettings({ memoriesEnabled: true });
});
afterEach(() => {
	setSettings({ memoriesEnabled: true });
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

/** Let a forked fibre's continuations run (the `plugins.test.ts` shape). */
const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

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

	test("a persisted locked-off area still resolves on — the lock holds on read", () => {
		// A hand-edited `settings.json`, an imported backup, or a full-trust
		// plugin through `host.db` can hand the store `{"app.substrate":
		// {"enabled": false}}`, and the same door can turn off a *contribution*
		// of a locked area — here the manager's own section, which is the way
		// back. The store refuses both writes, but an unclamped read would
		// honour them; the lock is a *store* guarantee (spec "The locked core"),
		// so the read door must refuse them too.
		const h = makeHarness(
			withBuiltins({
				"app.substrate": { enabled: false },
				"app.builtins": {
					enabled: false,
					contributions: { "settings.section.plugins": false },
				},
			}),
		);
		h.store.start();

		const snapshot = h.store.getBuiltinsSnapshot();
		expect(snapshot.builtins["app.substrate"]).toBe(true);
		expect(snapshot.builtins["app.builtins"]).toBe(true);
		// A contribution of a locked area is clamped too: it is what the gate
		// reads, so `false` here would unregister the manager's own section and
		// take away the way back.
		expect(snapshot.contributions["app.builtins"]).toEqual({
			"settings.section.plugins": true,
		});

		// A read clamp, not a migration: the blob is left exactly as written, so
		// an older app opening this data sees what it wrote, and nothing was
		// persisted on the way.
		expect(h.settings().builtins?.["app.substrate"]).toEqual({
			enabled: false,
		});
		expect(h.settings().builtins?.["app.builtins"]?.contributions).toEqual({
			"settings.section.plugins": false,
		});
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
	// Contribution-level state in the store's own shape, so this fake applies the
	// **production** rule (`contributionEnabled`) rather than a second copy of it.
	let contributions: Record<string, Record<string, boolean>> = {};
	return {
		enabledOf: (id: string): boolean => !disabled.has(id),
		contributionEnabledOf: (areaId: string, contributionId: string): boolean =>
			contributionEnabled(contributions, areaId, contributionId),
		set: (id: string, on: boolean): void => {
			if (on) disabled.delete(id);
			else disabled.add(id);
		},
		setContribution: (
			areaId: string,
			contributionId: string,
			on: boolean,
		): void => {
			contributions = {
				...contributions,
				[areaId]: { ...contributions[areaId], [contributionId]: on },
			};
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

		// Every area whose contribution catalog is non-empty registers something —
		// the two locked ones included: `app.builtins` carries the manager's
		// section (Task 5a's move) and `app.substrate` the settings surface its
		// sections render into (this round's move, so the manager keeps a surface
		// when `app.settings` is off). Read each area alone, through the same
		// reconciler, and union the results.
		const union: Record<RegistryName, Set<string>> = {
			ui: new Set(),
			commands: new Set(),
			tools: new Set(),
			providers: new Set(),
			themes: new Set(),
		};
		// The anti-vacuity guard for the union below: an area that declares a
		// contribution registers at least one. `app.titler` declares none yet (an
		// empty catalog — it registers no registry entry, only a scope-owned run),
		// so it is exempt; a later task adds its settings section and closes the
		// gap. The catalog is checked against the real registries in
		// `ui/plugins/BuiltinsArea.test.ts`.
		for (const area of BUILTIN_AREAS) {
			enabled.only(area.id);
			await run(reconciler, services);
			const alone = registryIds(services);
			const seen = REGISTRIES.flatMap((name) => alone[name]);
			if (BUILTIN_CONTRIBUTIONS[area.id as BuiltinId].length > 0) {
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
		expect(registered.tools).toEqual(ALL_TOOLS);
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

			// Each toggleable area that declares a contribution contributes
			// something, so "what that area alone contributes" is a real remainder,
			// not an empty set. `app.titler` declares none yet (an empty catalog),
			// so it is exempt — disabling it removes no registry entry.
			if (
				area.locked !== true &&
				BUILTIN_CONTRIBUTIONS[area.id as BuiltinId].length > 0
			) {
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
		// tools area and leaves `ui` untouched. The memory area's tools are the
		// only other tools, so they are what remains.
		enabled.all();
		enabled.set("app.tools", false);
		await run(reconciler, services);
		const direct = registryIds(services);
		expect(direct.tools).toEqual([...MEMORY_TOOL_NAMES]);
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
			expect(registryIds(services).tools, "off empties the area").toEqual([
				...MEMORY_TOOL_NAMES,
			]);

			enabled.set("app.tools", true);
			await run(reconciler, services);
			expect(registryIds(services), "on restores it exactly").toEqual(baseline);

			enabled.set("app.tools", false);
			await run(reconciler, services);
			expect(registryIds(services).tools, "off again empties it").toEqual([
				...MEMORY_TOOL_NAMES,
			]);

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
		expect(baseline.tools).toEqual(ALL_TOOLS);

		clearLog();
		failing = true;
		await run(reconciler, services);

		const after = registryIds(services);
		// The failed area registered nothing: its one partial contribution was
		// rolled back with its scope rather than left behind. Only the memory
		// area's tools remain.
		expect(after.tools).toEqual([...MEMORY_TOOL_NAMES]);
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

/* ------------------------------------------------------------------ the invariant */

/**
 * Task 6's invariant: with **every non-locked area off** the registries hold
 * exactly the locked contributions and nothing else, and restoring the areas
 * returns them to the ids and counts they had.
 *
 * This is a **count-based proxy** for the spec's "the substrate alone" (spec
 * "Testing": "with every built-in off, the rendered DOM equals the substrate
 * alone"). The suite reads registries, not the DOM, so the strongest claim it
 * can hold is that no toggleable area's registrations survive a state in which
 * every one of them is off; the DOM half is proven on the production bundle in
 * the browser step, which is where a rendered page exists to compare.
 *
 * The enabled-state source here is the injected fake, not the store, so this
 * test can hand the reconciler a state the store would refuse — a locked area
 * off. That is deliberate: what is under test is what the reconcile does with
 * the state it is given, and it is what makes the "exactly the locked
 * contributions" clause non-vacuous (see the report's negative control).
 */
describe("the invariant: every non-locked area off leaves exactly the locked core", () => {
	test("holds exactly the locked contributions, and restoring returns the prior ids", async () => {
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
		const before = registryIds(services);

		// The bare-host state: every area a user can turn off, off; the two locked
		// ones left on exactly as the store keeps them — which is the state the
		// bare preset produces (the way back lives in `app.builtins`).
		for (const area of BUILTIN_AREAS) {
			if (area.locked !== true) enabled.set(area.id, false);
		}
		await run(reconciler, services);
		const bare = registryIds(services);

		// Exactly the locked contributions: the container's settings surface plus
		// the manager's one section — and every other registry is empty, not merely
		// shorter. Both survivors are locked-area entries, which is the point.
		expect(bare.ui, "the locked core's own entries survive").toEqual([
			"settings.root.shell",
			"settings.section.plugins",
		]);
		expect(bare.commands).toEqual([]);
		expect(bare.tools).toEqual([]);
		expect(bare.providers).toEqual([]);
		expect(bare.themes).toEqual([]);
		// No area registers a pipeline stage today, so this line is a guard for a
		// future one rather than a live discriminator (stated plainly: it cannot
		// fail against the current table).
		expect(idsOf(Effect.runSync(services.pipeline.entries()))).toEqual([]);

		// Owned by the locked areas themselves, so the survivors are those areas'
		// own registrations and not leftovers of a disabled area.
		expect(idsOf(Effect.runSync(services.ui.ownedBy("app.substrate")))).toEqual(
			["settings.root.shell"],
		);
		expect(idsOf(Effect.runSync(services.ui.ownedBy("app.builtins")))).toEqual([
			"settings.section.plugins",
		]);

		// Restoring puts back identical ids, in identical order, and identical
		// counts.
		enabled.all();
		await run(reconciler, services);
		const after = registryIds(services);
		expect(after).toEqual(before);
		for (const name of REGISTRIES) {
			expect(after[name].length, `${name} count`).toBe(before[name].length);
		}
	});

	test("the container routes back to the manager with every non-locked area off", async () => {
		// The finding this closes: the locked set is a *registration* guarantee,
		// and reachability is a separate property. `app.shell` owns the only
		// `ui.root.layout`, so with it off the container used to render nothing at
		// all (`#root` at 0 chars, measured in the browser) while the manager stayed
		// registered. The container's own surface is the route back, and this
		// asserts the **reachable target**, not that something rendered.
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		// The resolved flags, from the same source the reconcile above just read:
		// one entry per identity, which is what the store's snapshot carries.
		const flags = (): Record<string, boolean> =>
			Object.fromEntries(
				BUILTIN_AREAS.map((area) => [area.id, enabled.enabledOf(area.id)]),
			);
		/** What the container's `<Slot id="ui.root.layout">` resolves to. */
		const rootEntries = (): readonly Contribution[] =>
			Effect.runSync(services.ui.entries()).filter(
				(entry) => entry.slot === "ui.root.layout",
			);

		enabled.all();
		await run(reconciler, services);
		// With a layout present the surface stays out of the page — it is the
		// last resort, not a second layout beside the shell.
		expect(rootEntries().length).toBeGreaterThan(0);
		expect(minimalHostView(rootEntries(), flags()).engaged).toBe(false);

		for (const area of BUILTIN_AREAS) {
			if (area.locked !== true) enabled.set(area.id, false);
		}
		await run(reconciler, services);

		// The state the container used to render as a blank page: the root layout
		// slot holds nothing at all.
		expect(rootEntries()).toEqual([]);

		const view = minimalHostView(rootEntries(), flags());
		expect(view.engaged, "the container renders a surface, not nothing").toBe(
			true,
		);

		// The reachable target, by identity: the manager's own component, the very
		// reference the manager's registered entry carries — not merely something
		// rendered, and not a second manager. The route is read as `unknown` so the
		// comparison needs no cast of its own.
		const manager = Effect.runSync(services.ui.entries()).find(
			(entry) => entry.id === "settings.section.plugins",
		);
		expect(
			manager?.component,
			"the manager's entry carries its component",
		).toBe(PluginsSection);
		const route: unknown = view.route;
		expect(route).toBe(manager?.component);

		// And it names what is off, so the surface says why the page is bare.
		expect(view.offLabels).toEqual(
			BUILTIN_AREAS.filter((area) => area.locked !== true).map(
				(area) => area.label,
			),
		);
	});
});

/* ---------------------------------------------------- per-contribution toggles */

/* ----------------------------------------------------- the manager's home */

/**
 * Task 5a: the Plugins manager section (`settings.section.plugins`) must ride
 * the locked `app.builtins` area, not the toggleable `app.settings` one.
 *
 * The assertions are the "way back" invariant the spec's success criterion 3
 * names: turning the whole Settings area off may remove every Settings
 * contribution, but not the manager — and a reconcile must register it as the
 * manager's own area, not as a survivor of `app.settings`.
 *
 * Task 6's fix round added the second half of that invariant, because being
 * *registered* turned out not to be being *reachable*: the settings **surface**
 * (`settings.root.shell`) every section renders into now rides the locked
 * `app.substrate`, so turning `app.settings` off leaves the manager's page
 * standing with the manager in it. Same move, one level along.
 */

describe("the manager rides the locked core", () => {
	const reconcilerOverRealAreas = () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});
		return { services, enabled, reconciler };
	};

	test("turning app.settings off keeps the manager reachable, through the locked surface", async () => {
		const { services, enabled, reconciler } = reconcilerOverRealAreas();

		enabled.all();
		await run(reconciler, services);
		expect(registryIds(services).ui).toContain("settings.section.plugins");

		enabled.set("app.settings", false);
		await run(reconciler, services);
		const entries = Effect.runSync(services.ui.entries());
		const ui = entries.map((entry) => entry.id);

		// The Settings area's own entries are gone — the manager is not simply
		// "the area stayed on".
		expect(ui).not.toContain("settings.section.providers");
		expect(ui).not.toContain("settings.section.notices");
		expect(ui).not.toContain("app.sidebar.chats");

		// What survives is the locked pair — and after this round the **surface is
		// one of them**. It used to be `app.settings`' own entry, so turning that
		// area off took the page the manager renders into: the manager stayed
		// registered and became unreachable (measured in the browser: a header-only
		// page). Now the surface rides the container, so the page survives with it.
		const surface = entries.find((entry) => entry.id === "settings.root.shell");
		expect(surface?.slot, "the settings page still has its surface").toBe(
			"settings.root",
		);
		expect(surface?.component).toBe(SettingsShell);
		expect(
			idsOf(Effect.runSync(services.ui.ownedBy("app.substrate"))),
			"the surface is the locked container's entry, not the settings area's",
		).toEqual(["settings.root.shell"]);

		// The reachable target, by identity: the surface renders the slot the
		// manager's own section is registered into, and that section is the
		// manager's component. (That `SettingsShell` renders `settings.sections` is
		// traced to `ui/Settings.tsx`, not asserted here; the browser run proves the
		// rendered result.)
		const manager = entries.find(
			(entry) => entry.id === "settings.section.plugins",
		);
		expect(manager?.slot).toBe("settings.sections");
		expect(manager?.component).toBe(PluginsSection);
		expect(idsOf(Effect.runSync(services.ui.ownedBy("app.builtins")))).toEqual([
			"settings.section.plugins",
		]);
	});

	test("with everything on, the manager is the last settings.sections entry and the same component", async () => {
		const { services, enabled, reconciler } = reconcilerOverRealAreas();

		enabled.all();
		await run(reconciler, services);
		const sections = Effect.runSync(services.ui.entries()).filter(
			(entry) => entry.slot === "settings.sections",
		);

		// The move kept the render order: every section that lands in
		// `settings.sections` by its explicit `order`, then the manager. Memory
		// rides `app.memory` now (its area owns it) but still sorts here at 70;
		// the order, not the owning area, is what this list pins.
		expect(sections.map((entry) => entry.id)).toEqual([
			"settings.section.notices",
			"settings.section.providers",
			"settings.section.provider-editor",
			"settings.section.profiles",
			"settings.section.profile-editor",
			"settings.section.web-search",
			"settings.section.memory",
			"settings.section.backup",
			"settings.section.updates",
			"settings.section.plugins",
		]);
		// Identity, not a wrapper: the manager's own component.
		expect(sections.at(-1)?.component).toBe(PluginsSection);
	});
});

describe("areaEnabled", () => {
	test("an area is on only when its flag is exactly true", () => {
		expect(areaEnabled({ "app.shell": true }, "app.shell")).toBe(true);
		expect(areaEnabled({ "app.shell": false }, "app.shell")).toBe(false);
		// The one input where this rule differs from `contributionEnabled`'s
		// absent-means-on form — pinned so a drift to that form fails here.
		expect(areaEnabled({}, "app.shell")).toBe(false);
	});
});

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
		expect(registryIds(services).tools).toEqual(ALL_TOOLS);

		enabled.setContribution("app.tools", "fetch_url", false);
		await run(reconciler, services);

		// `fetch_url` is not registered at all — off is indistinguishable from
		// never existed — and its sibling is untouched.
		expect(registryIds(services).tools).toEqual([
			"web_search",
			...MEMORY_TOOL_NAMES,
		]);
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

	test("an off contribution leaves the rest of its area registered across a reconcile", async () => {
		// What this proves: after a real store change, a reconcile registers the
		// rest of the area rather than emptying it. What it does **not** prove:
		// that the store's subscription fires a reconcile — `reconcile` is called
		// by hand here, and the subscription wiring is Task 3's (`state/plugins.ts`
		// shape) and is exercised by the app's boot, not by this suite.
		const services = makeServices();
		const h = makeHarness();
		h.store.start();

		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => areaEnabled(h.snapshot().builtins, areaId),
			contributionEnabledOf: (areaId, contributionId) =>
				contributionEnabled(h.snapshot().contributions, areaId, contributionId),
			makeHost,
		});

		await run(reconciler, services);
		const baseline = registryIds(services);

		h.store.setContributionEnabled("app.tools", "fetch_url", false);
		// The store really changed: its resolved snapshot now records it off.
		expect(h.snapshot().contributions["app.tools"]?.fetch_url).toBe(false);
		await run(reconciler, services);

		const after = registryIds(services);
		// The area is not emptied: its remaining tool is registered.
		expect(after.tools).toEqual(["web_search", ...MEMORY_TOOL_NAMES]);
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
			enabledOf: (areaId) => areaEnabled(h.snapshot().builtins, areaId),
			contributionEnabledOf: (areaId, contributionId) =>
				contributionEnabled(h.snapshot().contributions, areaId, contributionId),
			makeHost,
		});

		await run(reconciler, services);

		// The stale id matches nothing to skip, so both tools register; no crash,
		// no effect. The stored state is left exactly as found (no migration).
		expect(registryIds(services).tools).toEqual(ALL_TOOLS);
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

	test("an interrupted teardown still closes every scope it had not reached", async () => {
		// The parked-A fix made this reachable: an interrupt is re-raised, so a
		// reconcile cancelled mid-teardown aborts the close loop. `live` is
		// cleared before the loop, so without a cleanup pass the areas after the
		// interruption point are abandoned with their scopes open — leaking
		// everything they own (an `app.themes` `host.run` subscriber included).
		const services = makeServices();
		const closed: string[] = [];

		// Teardown walks the live list in reverse, so the **last** area here is
		// closed first; its finalizer records it and then interrupts, aborting the
		// loop with the other three still open.
		const ids = ["app.a", "app.b", "app.c", "app.interrupter"] as const;
		const areas: readonly BuiltinArea[] = ids.map((id) => ({
			id,
			label: id,
			description: "A test-only area used to observe teardown.",
			locked: false,
			register: () => {},
		}));

		const recordingMakeHost = (
			service: HostServicesShape,
			areaId: string,
			areaScope: Scope.Scope,
		): Host => {
			const finalizer =
				areaId === "app.interrupter"
					? Effect.sync(() => {
							closed.push(areaId);
						}).pipe(Effect.andThen(Effect.interrupt))
					: Effect.sync(() => {
							closed.push(areaId);
						});
			Effect.runSync(
				Effect.provideService(
					Scope.addFinalizer(areaScope, finalizer),
					Scope.Scope,
					areaScope,
				),
			);
			return makeHost(service, areaId, areaScope);
		};

		const reconciler = makeBuiltinsReconciler({
			areas,
			enabledOf: () => true,
			contributionEnabledOf: () => true,
			makeHost: recordingMakeHost,
		});

		await run(reconciler, services);
		closed.length = 0;

		// Close-first aborts on the interrupter; the interrupt propagates, and the
		// teardown cleanup must still close the other three.
		const exit = await Effect.runPromiseExit(reconciler.reconcile(services));
		expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		expect(new Set(closed)).toEqual(new Set(ids));
	});
});

/* --------------------------------------------------- the coalescing runner */

/**
 * The wiring's one serialisation point (`builtin/index.ts`
 * `makeCoalescingRunner`). A store change while a reconcile is in flight must
 * run **once more after** it, never beside it: `reconcile` clears its live list
 * before it closes and re-registers, so two overlapping passes would both find
 * nothing to close and accumulate one scope per area.
 *
 * The first run is held open on a `Deferred` so the later notifications
 * genuinely arrive mid-flight — the burst a rapid series of settings changes
 * produces. Without the latch those notifications fork their own reconciles at
 * once (`runs` is 2 before the first is released, and two runs are concurrent),
 * which is what the assertions catch.
 */
describe("the coalescing runner", () => {
	test("two notifications in the same turn register each area once, never beside the first", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		enabled.all();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		const held = Effect.runSync(Deferred.make<void>());
		let runs = 0;
		let concurrent = 0;
		let maxConcurrent = 0;

		const notify = makeCoalescingRunner(() => {
			runs += 1;
			const first = runs === 1;
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			return (first ? Deferred.await(held) : Effect.void).pipe(
				Effect.andThen(reconciler.reconcile(services)),
				Effect.ensuring(
					Effect.sync(() => {
						concurrent -= 1;
					}),
				),
			);
		});

		notify();
		notify();
		notify();

		// While the first is held, the later notifications are pending, not
		// running: no second reconcile started beside it.
		expect(runs).toBe(1);
		expect(maxConcurrent).toBe(1);

		Effect.runSync(Deferred.succeed(held, undefined));
		await tick();

		expect(runs, "the held run plus exactly one coalesced run").toBe(2);
		expect(maxConcurrent, "never two reconciles at once").toBe(1);
		// One scope per area, not one per notification: the coalesced pass
		// closed the held run's scopes before it registered its own.
		expect(reconciler.live().length).toBe(BUILTIN_AREAS.length);
		// And every area's ids are registered once, not duplicated.
		const ids = registryIds(services);
		for (const [name, list] of Object.entries(ids)) {
			expect(new Set(list).size, `${name} has no duplicates`).toBe(list.length);
		}
		expect(ids.ui).toContain("ui.root.layout");
		expect(ids.tools).toEqual(ALL_TOOLS);
	});
});

describe("memory tools follow the stored flag (explicit, not ambient)", () => {
	test("memoriesEnabled off ⇒ the five are absent; on ⇒ present", async () => {
		const services = makeServices();
		const enabled = makeEnabled();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: enabled.enabledOf,
			contributionEnabledOf: enabled.contributionEnabledOf,
			makeHost,
		});

		enabled.all();
		setSettings({ memoriesEnabled: false });
		await run(reconciler, services);
		const off = registryIds(services);
		expect(off.tools).toEqual(["fetch_url", "web_search"]);

		setSettings({ memoriesEnabled: true });
		await run(reconciler, services);
		const on = registryIds(services);
		expect(on.tools).toEqual(ALL_TOOLS);
	});
});
