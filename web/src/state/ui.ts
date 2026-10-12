import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The shell's view state (spec §4). It is a store rather than `App`'s local
 * `useState` because the controls that flip it are slot contributions: a
 * contribution cannot reach its host component's state, and a plugin must be
 * able to switch the view too. Small, synchronous and in-memory — nothing here
 * is persisted, so there is no `db` half.
 *
 * zod is the source of truth for the type (spec §1) even though the value
 * never leaves memory: the schema is what validates a write, so the union a
 * caller can set and the union the type admits cannot drift.
 */
export const uiStateSchema = z.object({
	view: z.enum(["chat", "settings"]),
	palette: z.boolean(),
});

export type UIState = z.infer<typeof uiStateSchema>;

/** Which top-level view the shell shows. */
export type UIView = UIState["view"];

let current: UIState = { view: "chat", palette: false };

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

export const getUIState = (): UIState => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

/**
 * Validate the merged result and drop an invalid patch silently, exactly as
 * `state/settings.ts` does: the store only ever holds a value its own schema
 * accepts, so a caller cannot wedge the shell into an unknown view.
 */
const update = (patch: Partial<UIState>): void => {
	const parsed = uiStateSchema.safeParse({ ...current, ...patch });
	if (!parsed.success) return;
	current = parsed.data;
	notify();
};

export const setView = (view: UIView): void => update({ view });

export const setPalette = (open: boolean): void => update({ palette: open });

export const useUIState = (): UIState =>
	useSyncExternalStore(subscribe, getUIState);
