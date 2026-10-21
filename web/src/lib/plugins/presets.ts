import { PluginFault } from "@lib/plugins/errors";
import { type Host, type HostRegistry, HostServices } from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import {
	mergeProviderPresets,
	PROVIDER_PRESETS,
	type ProviderPreset,
} from "@lib/providers/presets";
import type { ToolSpec } from "@lib/providers/types";
import { Effect, Stream } from "effect";
import { z } from "zod";

/** The wire shape a plugin registers: what `ProviderPreset` carries. */
export const presetSchema = z.object({
	id: z.string().min(1),
	label: z.string(),
	baseUrl: z.string().min(1),
	protocol: z.string().min(1),
	tools: z
		.array(
			z.object({
				type: z.string(),
				max_num_results: z.number(),
			}),
		)
		.optional(),
});

export type PresetDefinition = z.infer<typeof presetSchema>;

/**
 * A stored preset: the definition plus the plugin that owns it. `owner` is
 * stamped by the host, never by the registrar's caller.
 */
export interface PresetEntry extends RegistryEntry {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly protocol: string;
	readonly tools?: readonly ToolSpec[];
}

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

const refuse = (detail: string, pluginId?: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

const asPresetEntry = (entry: RegistryEntry): PresetEntry =>
	entry as PresetEntry;

const toPreset = (entry: PresetEntry): ProviderPreset => ({
	id: entry.id,
	label: entry.label,
	baseUrl: entry.baseUrl,
	protocol: entry.protocol,
	tools: entry.tools,
});

const addPreset = (
	registry: HostRegistry<PresetEntry>,
	preset: unknown,
	pluginId?: string,
): Disposable => {
	const declared = (preset as { readonly id?: unknown } | undefined)?.id;
	const parsed = presetSchema.safeParse(preset);
	if (!parsed.success) {
		refuse(
			`the preset "${String(declared)}" is invalid: ${parsed.error.message}`,
			pluginId,
		);
		return noopDisposable;
	}
	const data = parsed.data;
	// Built-ins win a collision: a plugin cannot shadow a shipped preset.
	if (PROVIDER_PRESETS.some((builtIn) => builtIn.id === data.id)) {
		refuse(
			`a preset named "${data.id}" is already a built-in; the plugin registration was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	const taken = Effect.runSync(registry.entries()).some(
		(entry) => entry.id === data.id,
	);
	if (taken) {
		refuse(
			`a preset named "${data.id}" is already registered; the later registration was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	return registry.register({
		id: data.id,
		label: data.label,
		baseUrl: data.baseUrl,
		protocol: data.protocol,
		tools: data.tools as readonly ToolSpec[] | undefined,
	});
};

export interface PresetRegistry {
	register(preset: PresetDefinition, pluginId?: string): Disposable;
	readonly entries: () => Effect.Effect<readonly PresetEntry[]>;
	readonly ownedBy: (owner: string) => Effect.Effect<readonly PresetEntry[]>;
	readonly changes: Stream.Stream<readonly PresetEntry[]>;
}

export const makePresetRegistry = (
	registry: HostRegistry<RegistryEntry>,
	pluginId: string,
): PresetRegistry => {
	const presets = registry as unknown as HostRegistry<PresetEntry>;
	return {
		register: (preset, label) => addPreset(presets, preset, label ?? pluginId),
		entries: presets.entries,
		ownedBy: presets.ownedBy,
		changes: presets.changes,
	};
};

export const registerPreset = (
	host: Host,
	preset: PresetDefinition,
	pluginId?: string,
): Disposable => host.presets.register(preset, pluginId);

/** Every registered preset, in resolution order. */
export const listPresets = (): Effect.Effect<
	readonly PresetEntry[],
	never,
	HostServices
> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.map(services.presets.entries(), (entries) =>
			entries.map(asPresetEntry),
		),
	);

/* ---------------------------------------------------------------- React bridge */

let snapshot: readonly ProviderPreset[] = mergeProviderPresets(
	PROVIDER_PRESETS,
	[],
);
const snapshotListeners = new Set<() => void>();

export const getProviderPresetsSnapshot = (): readonly ProviderPreset[] =>
	snapshot;

export const subscribeProviderPresets = (
	listener: () => void,
): (() => void) => {
	snapshotListeners.add(listener);
	return () => {
		snapshotListeners.delete(listener);
	};
};

let bridgeInstalled = false;

export const installPresetBridge = (): void => {
	if (bridgeInstalled) return;
	bridgeInstalled = true;
	snapshot = mergeProviderPresets(
		PROVIDER_PRESETS,
		runtime.runSync(listPresets()).map(toPreset),
	);
	runtime.runFork(
		Effect.gen(function* () {
			const services = yield* HostServices;
			yield* Stream.runForEach(services.presets.changes, (entries) =>
				Effect.sync(() => {
					snapshot = mergeProviderPresets(
						PROVIDER_PRESETS,
						entries.map(asPresetEntry).map(toPreset),
					);
					for (const listener of snapshotListeners) listener();
				}),
			);
		}),
	);
};
