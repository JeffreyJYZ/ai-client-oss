import { getRegistrySnapshot, subscribeRegistry } from "@lib/plugins/bridge";
import type { Contribution } from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

/**
 * The contributions rendering into one slot, in resolution order (spec §4):
 * the registry already sorted them by `order`, then `priority`, then
 * registration order, so this only filters by slot and drops hidden entries.
 * Hidden entries stay registered (spec §4) — they can be unhidden — which is
 * why the filter lives here and not in the registry.
 */
export const useContribution = (slot: SlotId): readonly Contribution[] =>
	useSyncExternalStore(subscribeRegistry, getRegistrySnapshot).filter(
		(entry) => entry.slot === slot && entry.hidden !== true,
	);

/** Nothing registered: render nothing rather than crash (see `useComponent`). */
const NONE: ComponentType<Record<string, unknown>> = () => null;

/** The `componentId` half of a name that may or may not carry the `ui.` prefix. */
const componentId = (id: string): string =>
	id.startsWith("ui.") ? id.slice("ui.".length) : id;

/**
 * The component registered for one overridable id (spec §4): the
 * highest-priority entry wins, else the built-in. The argument and the
 * registered id are compared on that one `componentId`, so a caller may pass
 * either `"markdown"` or `"ui.markdown"`, and a built-in at `ui.<componentId>`
 * (spec §4's location) is shadowed by a same-`componentId` override at a higher
 * priority — the shape that lets an override be disposed and the built-in
 * reappear, rather than replacing it in place. Exported separately from the
 * hook so the resolution rule is testable without a DOM.
 */
export const resolveComponent = (
	entries: readonly Contribution[],
	id: string,
): ComponentType<Record<string, unknown>> | undefined => {
	const key = componentId(id);
	const matches = entries.filter(
		(entry) => entry.hidden !== true && componentId(entry.id) === key,
	);
	if (matches.length === 0) return undefined;
	return matches.reduce((best, entry) =>
		(entry.priority ?? 0) > (best.priority ?? 0) ? entry : best,
	).component;
};

/**
 * Resolve a single overridable component (spec §4) — the seam that lets a
 * plugin replace the built-in message renderer, markdown body, composer, etc.
 * Reading the registry through the same store `Slot` uses means an override
 * takes effect on the next render; an unregistered id renders nothing so a
 * missing built-in degrades to an empty region instead of a crash.
 */
export const useComponent = (
	id: string,
): ComponentType<Record<string, unknown>> => {
	const entries = useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);
	return resolveComponent(entries, id) ?? NONE;
};
