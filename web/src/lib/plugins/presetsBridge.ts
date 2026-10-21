import { HostServices } from "@lib/plugins/host";
import type { PresetEntry } from "@lib/plugins/presets";
import { runtime } from "@lib/plugins/runtime";
import {
	mergeProviderPresets,
	PROVIDER_PRESETS,
	type ProviderPreset,
} from "@lib/providers/presets";
import { Effect, Stream } from "effect";
import { useSyncExternalStore } from "react";

/**
 * The React-facing projection of the `presets` registry — its own module on
 * purpose.
 *
 * It cannot live beside the registry in `presets.ts`: `host.ts` imports that
 * module to build `HostServices`, so a `runtime` import there closes the cycle
 * `runtime` → `host` → `presets` → `runtime`, and the bundle dies at boot with
 * `ReferenceError: Cannot access 'HostLayer' before initialization` (measured
 * 2026-10-21). `bridge.ts` already owns the same shape for `ui`, and nothing in
 * the host imports it.
 *
 * The snapshot starts as the built-ins alone and is replaced by each emission
 * of the registry's `changes` stream, which replays the current entries to a
 * new subscriber — so one fork covers both the present and every later
 * registration, and there is no synchronous registry read to trip over.
 */

const toPreset = (entry: PresetEntry): ProviderPreset => ({
	id: entry.id,
	label: entry.label,
	baseUrl: entry.baseUrl,
	protocol: entry.protocol,
	tools: entry.tools,
});

let snapshot: readonly ProviderPreset[] = mergeProviderPresets(
	PROVIDER_PRESETS,
	[],
);
const listeners = new Set<() => void>();

/** Referentially stable between emissions — `useSyncExternalStore` needs it. */
export const getProviderPresetsSnapshot = (): readonly ProviderPreset[] =>
	snapshot;

export const subscribeProviderPresets = (
	listener: () => void,
): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

let installed = false;

/** Start the projection. Idempotent; runs once, after the boot's runtime. */
export const installPresetBridge = (): void => {
	if (installed) return;
	installed = true;
	runtime.runFork(
		Effect.gen(function* () {
			const services = yield* HostServices;
			yield* Stream.runForEach(services.presets.changes, (entries) =>
				Effect.sync(() => {
					snapshot = mergeProviderPresets(
						PROVIDER_PRESETS,
						(entries as readonly PresetEntry[]).map(toPreset),
					);
					for (const listener of listeners) listener();
				}),
			);
		}),
	);
};

/** Built-in presets plus every live plugin preset, for a component. */
export const useProviderPresets = (): readonly ProviderPreset[] =>
	useSyncExternalStore(subscribeProviderPresets, getProviderPresetsSnapshot);
