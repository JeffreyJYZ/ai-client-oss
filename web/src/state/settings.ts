import { db, Settings, settingsDefaults } from "@lib/db";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";

/**
 * In-memory snapshot. Seeded with defaults so the app boots before hydration
 * (and if hydration fails) — `db` owns the persistence, this store is a
 * synchronous read cache over it.
 */
let current: Settings = settingsDefaults();

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

export const getSettings = (): Settings => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

/** Persistence is best-effort: a failure is logged, never thrown at callers. */
const persist = (patch: Partial<Settings>): void => {
	Effect.runFork(
		Effect.catch(db.setSettings(patch), (error) =>
			Effect.logError(`failed to persist settings: ${error}`),
		),
	);
};

/**
 * Write-through: update memory + notify synchronously, then persist. The store
 * validates the merged result; an invalid patch is dropped silently so the
 * adapter only ever sees a valid patch.
 */
export const setSettings = (patch: Partial<Settings>): void => {
	const parsed = Settings.safeParse({ ...current, ...patch });
	if (!parsed.success) return;
	current = parsed.data;
	notify();
	persist(patch);
};

// Hydrate from `db` on module load; until it resolves `current` stays defaults.
Effect.runFork(
	Effect.flatMap(db.getSettings(), (settings) =>
		Effect.sync(() => {
			current = settings;
			notify();
		}),
	),
);

export const useSettings = (): Settings =>
	useSyncExternalStore(subscribe, getSettings);
