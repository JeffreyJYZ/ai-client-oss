import { beforeEach, describe, expect, test } from "bun:test";
import { Settings, settingsDefaults } from "@lib/db";
import {
	BUILTIN_IDENTITIES,
	LOCKED_BUILTIN_IDS,
} from "@lib/plugins/builtinIdentity";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
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
		// `BUILTIN_AREAS` would compare an expression with itself, so a third
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
