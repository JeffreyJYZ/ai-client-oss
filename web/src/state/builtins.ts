import type { Settings } from "@lib/db";
import {
	BUILTIN_IDENTITIES,
	type BuiltinIdentity,
} from "@lib/plugins/builtinIdentity";
import { recordLog } from "@lib/plugins/log";
import { useSyncExternalStore } from "react";
import {
	getSettings,
	setSettings,
	subscribe as subscribeSettings,
} from "@/state/settings";

/**
 * The built-in store (spec "Persistence" and "The locked core"): which built-in
 * areas and contributions are on, and the only door to persisting that state.
 *
 * It is a module snapshot plus a listener set, exactly like `state/settings.ts`
 * and `state/plugins.ts`, so React reads it through `useSyncExternalStore` and no
 * new state library appears.
 *
 * Three properties are deliberate:
 *
 * - **Absent means on.** The persisted field is optional and the snapshot's
 *   defaults are computed, never stored, so a blob written before the field
 *   existed reads as "everything on" and there is no migration. An id that no
 *   longer exists is likewise harmless: the store neither reads a stale id as
 *   state for a real area nor prunes it from storage.
 * - **The snapshot has a stable identity.** It is replaced only when the
 *   resolved state actually differs, because `useSyncExternalStore` compares
 *   `getSnapshot()` by identity on every render — a fresh object per read is an
 *   infinite render loop.
 * - **Locked units are refused here, in the store** (spec "Error handling"), not
 *   only in the UI, so a future caller cannot bypass the irreducible core. Both
 *   doors are covered: a toggle of a locked unit is refused at the write, and
 *   `resolve` clamps the read, so a hand-edited blob that says a locked area —
 *   or one of its contributions — is off is not honoured either.
 *
 * Registration is not this module's job: it holds and persists the state, and
 * Task 3's reconcile is what acts on it.
 *
 * The identities come from `builtinIdentity.ts` — a leaf importing nothing —
 * rather than from `areas.ts`, which imports every registrar and through them
 * the UI and the chat store. Reading them through the area table would make the
 * Plugins section import the store that imports the section: a cycle into this
 * module, whose bottom starts the store.
 */

/** What the Plugins section reads. */
export interface BuiltinsSnapshot {
	/**
	 * The plugin subsystem's master switch, read through unchanged. It gates
	 * **installed** plugins only (spec, "What exists today") — the built-ins
	 * stay on regardless. It is exposed so the section's built-in controls can
	 * follow the same gate as its other controls.
	 */
	readonly enabled: boolean;
	/** One entry per area in {@link BUILTIN_IDENTITIES}; absent means on. */
	readonly builtins: Readonly<Record<string, boolean>>;
	/**
	 * The recorded per-contribution overrides, area → contribution id → on. An
	 * id no registry holds is carried here untouched (the store owns no
	 * contribution allowlist); it is inert because an id nothing registers
	 * matches nothing to skip.
	 */
	readonly contributions: Readonly<
		Record<string, Readonly<Record<string, boolean>>>
	>;
}

/** The persisted shape, derived from the schema so the two cannot drift. */
type BuiltinsRecord = NonNullable<Settings["builtins"]>;
type BuiltinEntry = BuiltinsRecord[string];

/**
 * Everything the store needs from outside itself, injected rather than imported
 * (the `state/plugins.ts` rule: a project module is never `mock.module`d) — so a
 * test drives the store with a fake settings value and the app wires the real
 * one at the bottom of this file.
 */
export interface BuiltinsDeps {
	readonly readSettings: () => Settings;
	readonly writeSettings: (patch: Partial<Settings>) => void;
	readonly subscribeSettings: (listener: () => void) => () => void;
}

/** The store surface, as `state/builtins.ts` exposes it. */
export interface BuiltinsStore {
	readonly getBuiltinsSnapshot: () => BuiltinsSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly useBuiltins: () => BuiltinsSnapshot;
	/** Subscribe to settings; idempotent, so a second call is a no-op. */
	readonly start: () => void;
	readonly setBuiltinEnabled: (id: string, on: boolean) => void;
	readonly setContributionEnabled: (
		areaId: string,
		contributionId: string,
		on: boolean,
	) => void;
	readonly applyBarePreset: () => void;
	readonly restoreAllBuiltins: () => void;
}

/**
 * Every key of a contribution record, turned on. Used by restore-all, and by
 * {@link resolve} to clamp a locked area's recorded overrides on.
 */
const allOn = (
	record: Readonly<Record<string, boolean>>,
): Record<string, boolean> => {
	const next: Record<string, boolean> = {};
	for (const key of Object.keys(record)) next[key] = true;
	return next;
};

/**
 * Resolve the persisted state into the snapshot (spec "Persistence"). Every area
 * in the table gets an explicit flag — `false` only when the store says so and
 * the area is not locked — and only areas the table knows contribute anything,
 * so a stale area id is ignored rather than surfaced. The whole record is
 * rebuilt here, pure.
 */
const resolve = (settings: Settings): BuiltinsSnapshot => {
	const state = settings.builtins ?? {};
	const builtins: Record<string, boolean> = {};
	const contributions: Record<string, Record<string, boolean>> = {};

	for (const identity of BUILTIN_IDENTITIES) {
		const entry = state[identity.id];
		// A locked area's flag is clamped **on this read**, not only refused on
		// the write: a hand-edited `settings.json`, an imported backup or a
		// full-trust plugin through `host.db` can set `enabled: false` without
		// passing the store's `refused` guard, and the lock is the store's own
		// guarantee (spec "The locked core"). Everything else keeps the
		// absent-means-on form.
		builtins[identity.id] =
			identity.locked === true || entry?.enabled !== false;
		const recorded = entry?.contributions;
		if (recorded !== undefined) {
			// The same clamp one level down. The store refuses to *write* a
			// contribution of a locked area off, so a recorded override saying it
			// is off can only come from a hand-edited blob or an import — and
			// honouring it would unregister that contribution (for `app.builtins`,
			// the manager's own section: the way back) while the area still reads
			// as locked. No ids are invented: the recorded keys are kept, forced
			// on.
			contributions[identity.id] =
				identity.locked === true ? allOn(recorded) : { ...recorded };
		}
	}

	return { enabled: settings.pluginsEnabled, builtins, contributions };
};

/** Whether two flat flag records hold the same keys and values. */
const sameFlags = (
	a: Readonly<Record<string, boolean>>,
	b: Readonly<Record<string, boolean>>,
): boolean => {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => b[key] === a[key])
	);
};

/** Whether two area → contribution → flag records are the same. */
const sameContributions = (
	a: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
	b: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
): boolean => {
	const areas = Object.keys(a);
	return (
		areas.length === Object.keys(b).length &&
		areas.every((areaId) => {
			const left = a[areaId];
			const right = b[areaId];
			if (left === undefined || right === undefined) return left === right;
			return sameFlags(left, right);
		})
	);
};

/**
 * Whether two snapshots carry the same state. Discovered by value, not by
 * identity, because that is the whole point: only a real change may replace the
 * object React holds.
 */
const sameSnapshot = (a: BuiltinsSnapshot, b: BuiltinsSnapshot): boolean =>
	a === b ||
	(a.enabled === b.enabled &&
		sameFlags(a.builtins, b.builtins) &&
		sameContributions(a.contributions, b.contributions));

/** Build a store over injected seams. The app builds the one in this module. */
export const makeBuiltinsStore = (deps: BuiltinsDeps): BuiltinsStore => {
	const listeners = new Set<() => void>();
	let started = false;
	// Resolved at construction, never `undefined`: an unstarted store still
	// answers with the settings it has, so no read path can find the state
	// uninitialized.
	let snapshot = resolve(deps.readSettings());

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	/**
	 * The only writer of `snapshot`, and the identity guard: a refresh whose
	 * resolved state is unchanged keeps the previous object and wakes nobody.
	 */
	const refresh = (): void => {
		const next = resolve(deps.readSettings());
		if (sameSnapshot(snapshot, next)) return;
		snapshot = next;
		notify();
	};

	/** Persist a whole record through the settings seam, then re-read it. */
	const write = (next: BuiltinsRecord): void => {
		deps.writeSettings({ builtins: next });
		refresh();
	};

	/**
	 * The current record, merged with one area's patch. Read-modify-write off the
	 * live settings, so a change made elsewhere in the app is never clobbered.
	 */
	const update = (areaId: string, patch: Partial<BuiltinEntry>): void => {
		const state = deps.readSettings().builtins ?? {};
		write({ ...state, [areaId]: { ...state[areaId], ...patch } });
	};

	/** The area a persisted id names, or `undefined` when the table has none. */
	const areaOf = (id: string): BuiltinIdentity | undefined =>
		BUILTIN_IDENTITIES.find((identity) => identity.id === id);

	/**
	 * Whether a toggle must be refused, logging why it was when it is. Two
	 * refusals live here: an id the table does not know (the table is the area
	 * allowlist, so writing one would only grow storage with junk), and an
	 * attempt to turn a **locked** unit off (spec "The locked core" — enforced
	 * at the store, so no caller can bypass the irreducible core).
	 */
	const refused = (areaId: string, on: boolean): boolean => {
		const area = areaOf(areaId);
		if (area === undefined) {
			recordLog(
				undefined,
				"warn",
				`there is no built-in area "${areaId}", so nothing was changed`,
			);
			return true;
		}
		if (area.locked === true && !on) {
			recordLog(
				areaId,
				"warn",
				`the built-in area "${areaId}" (${area.label}) is locked and cannot be disabled: the locked core is what guarantees a surface to render into and a way back`,
			);
			return true;
		}
		return false;
	};

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	/** The current snapshot. Referentially stable between real changes. */
	const getBuiltinsSnapshot = (): BuiltinsSnapshot => snapshot;

	const useBuiltins = (): BuiltinsSnapshot =>
		useSyncExternalStore(subscribe, getBuiltinsSnapshot);

	const start = (): void => {
		if (started) return;
		started = true;
		deps.subscribeSettings(refresh);
		refresh();
	};

	const setBuiltinEnabled = (id: string, on: boolean): void => {
		if (refused(id, on)) return;
		update(id, { enabled: on });
	};

	const setContributionEnabled = (
		areaId: string,
		contributionId: string,
		on: boolean,
	): void => {
		if (refused(areaId, on)) return;
		const recorded = deps.readSettings().builtins?.[areaId]?.contributions;
		update(areaId, {
			contributions: { ...recorded, [contributionId]: on },
		});
	};

	/**
	 * The bare preset (spec, goal 5): every non-locked area off, every locked one
	 * on, so the locked core survives the preset by construction. The recorded
	 * per-contribution overrides are kept — this action decides areas, and
	 * `restoreAllBuiltins` is what turns the drill-down back on.
	 */
	const applyBarePreset = (): void => {
		const state = deps.readSettings().builtins ?? {};
		const next: BuiltinsRecord = { ...state };
		for (const identity of BUILTIN_IDENTITIES) {
			next[identity.id] = {
				...next[identity.id],
				enabled: identity.locked === true,
			};
		}
		write(next);
	};

	/**
	 * Turn everything back on (spec, goal 5). The recorded overrides are set to
	 * on rather than dropped: "restore all" reverses the toggles, and an id that
	 * no longer exists stays inert either way.
	 *
	 * Only the areas the identity list names are touched: an entry no area claims
	 * (a newer app version's, or a renamed area's) is carried through **unchanged**,
	 * exactly as {@link applyBarePreset} carries it — rewriting it would mutate
	 * state this build does not own, which is the opposite of the field's
	 * forward-compatibility (spec "Persistence": unknown ids are ignored).
	 */
	const restoreAllBuiltins = (): void => {
		const state = deps.readSettings().builtins ?? {};
		const next: BuiltinsRecord = { ...state };
		for (const identity of BUILTIN_IDENTITIES) {
			const contributions = next[identity.id]?.contributions;
			next[identity.id] = {
				enabled: true,
				...(contributions === undefined
					? {}
					: { contributions: allOn(contributions) }),
			};
		}
		write(next);
	};

	return {
		getBuiltinsSnapshot,
		subscribe,
		useBuiltins,
		start,
		setBuiltinEnabled,
		setContributionEnabled,
		applyBarePreset,
		restoreAllBuiltins,
	};
};

/* ------------------------------------------------------------------- wiring */

const realDeps: BuiltinsDeps = {
	readSettings: getSettings,
	writeSettings: (patch) => {
		setSettings(patch);
	},
	subscribeSettings,
};

const store = makeBuiltinsStore(realDeps);

/**
 * Start the store: subscribe to the settings store so hydration and every later
 * change refresh the snapshot. **Idempotent** — `start()` returns immediately
 * once it has run, so a second call (a caller who is unsure, or a future import
 * cycle that evaluates this module's tail twice) cannot double-subscribe or
 * re-publish.
 *
 * The module starts itself at import, so the app needs to call nothing: by the
 * time React mounts, hydration is already being watched. This export is the
 * explicit door for a boot path that wants the order stated — Task 3's
 * `main.tsx` wiring may call it next to its `reconcileBuiltins(services)`, and
 * the call is then a no-op rather than a second start. Nothing is registered
 * here either way: Task 3's reconcile is what turns this state into live areas.
 */
export const startBuiltins = (): void => {
	store.start();
};

store.start();

/** The Plugins section's built-in snapshot. */
export const useBuiltins = store.useBuiltins;
export const getBuiltinsSnapshot = store.getBuiltinsSnapshot;
export const subscribe = store.subscribe;
export const setBuiltinEnabled = store.setBuiltinEnabled;
export const setContributionEnabled = store.setContributionEnabled;
export const applyBarePreset = store.applyBarePreset;
export const restoreAllBuiltins = store.restoreAllBuiltins;
