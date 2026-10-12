import { type Contribution, HostServices } from "@lib/plugins/host";
import { runtime } from "@lib/plugins/runtime";
import { Effect, Stream } from "effect";

/**
 * The React-facing snapshot of the `ui` registry (spec §3/§4). It is a module
 * variable on purpose: `useSyncExternalStore` compares `getSnapshot()`'s
 * return value by identity on every render and re-renders when it changes, so
 * the function must hand back the *same array* until the registry actually
 * mutates — returning a fresh array per call is an infinite render loop. Only
 * the fold below ever writes this variable.
 */
let snapshot: readonly Contribution[] = [];

/** Who to wake when the snapshot is replaced. */
const listeners = new Set<() => void>();

/**
 * The current registry snapshot. Referentially stable between mutations
 * (see above): every call with no mutation in between returns the identical
 * array.
 */
export const getRegistrySnapshot = (): readonly Contribution[] => snapshot;

/**
 * Subscribe to snapshot replacement, in the `useSyncExternalStore` shape the
 * existing stores use (`state/settings.ts`, `state/updates.ts`). The returned
 * function unsubscribes and is idempotent.
 */
export const subscribeRegistry = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/**
 * Fold one registry's `changes` stream into the module snapshot (spec §3):
 * every emission replaces the cached array and notifies each listener exactly
 * once, so a mutation produces exactly one new snapshot and one notification.
 * Pipe this into a forked fiber (`bootRegistryBridge`, or a test's own fork).
 */
export const installRegistryBridge = (
	changes: Stream.Stream<readonly Contribution[]>,
): Effect.Effect<void> =>
	Stream.runForEach(changes, (entries) =>
		Effect.sync(() => {
			snapshot = entries;
			for (const listener of listeners) listener();
		}),
	);

/**
 * Start the bridge against the app's one runtime (spec §3), forked at boot
 * before React mounts so the first render already sees the registry. The fiber
 * runs for the runtime's lifetime; there is no second runtime and no way to run
 * a fresh layer, so every registry consumer shares this one stream. Called by
 * `main.tsx` (Task 6).
 */
export const bootRegistryBridge = (): void => {
	runtime.runFork(
		Effect.gen(function* () {
			const services = yield* HostServices;
			yield* installRegistryBridge(services.ui.changes);
		}),
	);
};
