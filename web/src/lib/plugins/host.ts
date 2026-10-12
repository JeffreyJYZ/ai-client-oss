import { PluginFault } from "@lib/plugins/errors";
import { type SlotId, slotIdSchema } from "@lib/plugins/ids";
import {
	type Disposable,
	makeRegistry,
	type Registry,
	type RegistryEntry,
} from "@lib/plugins/registry";
import { Context, Effect, Layer, Scope, type Stream } from "effect";
import type { ComponentType } from "react";

/**
 * The plugin API this build implements (spec §10). A plugin declares
 * `apiVersion` in its manifest; the loader refuses a different major and
 * warns on a different minor, so a plugin built against an older API is
 * told to rebuild rather than run against an API it never saw.
 */
export const pluginApiVersion = "0.1";

/** The handle every registration already returns (spec §2). */
export type { Disposable };

/**
 * A plugin module's default export (spec §2). `id` must match the
 * manifest's — the loader reads identity from the manifest, so a module
 * cannot claim another plugin's id.
 */
export interface Plugin {
	readonly id: string;
	// `void | Disposable` is deliberate (spec §2): a `setup` may return nothing
	// or a handle to dispose first. Biome's `noConfusingVoidType` would rewrite
	// it to `undefined | Disposable`, which rejects a `setup` returning `void`.
	// biome-ignore lint/suspicious/noConfusingVoidType: see above
	setup(host: Host): void | Disposable;
}

/**
 * One UI contribution (spec §4): a component placed into a named slot.
 * `component` is resolved by the React bridge, `hidden` keeps it registered
 * while suppressing it, and `order`/`priority` are the shared sort keys.
 */
export interface Contribution extends RegistryEntry {
	readonly slot: SlotId;
	readonly component: ComponentType<Record<string, unknown>>;
	readonly hidden?: boolean;
}

/**
 * A registry as a plugin sees it (spec §2): `register` is synchronous and
 * returns the handle that removes exactly that entry, while reads stay
 * Effects/Streams because host and React callers drive them. The host always
 * stamps `owner` with the plugin it was built for — a plugin cannot register
 * on another plugin's behalf.
 */
export interface HostRegistry<E extends RegistryEntry> {
	register(entry: Omit<E, "owner">): Disposable;
	readonly entries: () => Effect.Effect<readonly E[]>;
	readonly ownedBy: (owner: string) => Effect.Effect<readonly E[]>;
	readonly changes: Stream.Stream<readonly E[]>;
}

/**
 * The surface a plugin is compiled against (spec §2). Every method that adds
 * something returns a `Disposable`, whose removal is attached to that plugin's
 * `Scope` — closing the scope is unload, so a disabled plugin leaves no trace.
 *
 * Only the synchronous registries live here. The service members a plugin
 * calls for behaviour (`chat`, `db`, `storage`, `notify`, `native`, `log`,
 * `on`) are populated by Task 16; they are deliberately absent rather than
 * stubbed, so nothing can be called that does nothing.
 */
export interface Host {
	/** The app and plugin-API versions a plugin is checked against (spec §10). */
	readonly version: { readonly app: string; readonly api: string };
	readonly ui: HostRegistry<Contribution>;
	readonly commands: HostRegistry<RegistryEntry>;
	readonly settings: HostRegistry<RegistryEntry>;
	readonly tools: HostRegistry<RegistryEntry>;
	readonly providers: HostRegistry<RegistryEntry>;
	readonly pipeline: HostRegistry<RegistryEntry>;
	readonly renderers: HostRegistry<RegistryEntry>;
	readonly themes: HostRegistry<RegistryEntry>;
}

/**
 * One registry per kind (spec §3), created once in `HostLayer`'s construction
 * so the whole app shares one collection per kind. `keybindings` is held here,
 * not on `Host`: a command carries its own keybinding, so the global key
 * handler reads this registry while plugins register through `commands`.
 */
export interface HostRegistries {
	readonly ui: Registry<Contribution>;
	readonly tools: Registry<RegistryEntry>;
	readonly providers: Registry<RegistryEntry>;
	readonly pipeline: Registry<RegistryEntry>;
	readonly commands: Registry<RegistryEntry>;
	readonly keybindings: Registry<RegistryEntry>;
	readonly settings: Registry<RegistryEntry>;
	readonly renderers: Registry<RegistryEntry>;
	readonly themes: Registry<RegistryEntry>;
}

/** The host service (spec §3): the registries, provided once at boot. */
export class HostServices extends Context.Service<
	HostServices,
	HostRegistries
>()("HostServices") {}

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/**
 * Add `entry` on behalf of the plugin whose `scope` this is, and return its
 * handle. `Registry.add` reads the ambient scope with `serviceOption`, so the
 * scope must be provided here or the entry is never collected; running the
 * whole mutate-and-finalize pair under `Effect.runSync` also closes the window
 * between the mutation and the finalizer, because a synchronous run has no
 * interruption point (see the task report's item-3 decision).
 */
const attach = <E extends RegistryEntry>(
	registry: Registry<E>,
	entry: E,
	scope: Scope.Scope,
): Disposable =>
	Effect.runSync(
		Effect.provideService(registry.add(entry), Scope.Scope, scope),
	);

/**
 * A registration refused for a bad value is a logged `PluginFault`, never a
 * thrown error (spec §9): one contribution is dropped, the plugin and the app
 * keep running.
 */
const refuse = (pluginId: string, detail: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

const makeHostRegistry = <E extends RegistryEntry>(
	registry: Registry<E>,
	pluginId: string,
	scope: Scope.Scope,
): HostRegistry<E> => ({
	register: (entry) =>
		attach(registry, { ...entry, owner: pluginId } as E, scope),
	entries: registry.entries,
	ownedBy: registry.ownedBy,
	changes: registry.changes,
});

/** `ui` alone validates its discriminating field before adding (spec §3). */
const makeContributionRegistry = (
	registry: Registry<Contribution>,
	pluginId: string,
	scope: Scope.Scope,
): HostRegistry<Contribution> => ({
	register: (entry) => {
		const slot = slotIdSchema.safeParse(entry.slot);
		if (!slot.success) {
			refuse(
				pluginId,
				`slot "${String(entry.slot)}" is not a known slot; contribution "${entry.id}" was refused`,
			);
			return noopDisposable;
		}
		return attach(
			registry,
			{ ...entry, slot: slot.data, owner: pluginId },
			scope,
		);
	},
	entries: registry.entries,
	ownedBy: registry.ownedBy,
	changes: registry.changes,
});

/**
 * The `Host` a plugin's `setup` receives (spec §2). Built per plugin from the
 * shared registries plus that plugin's `pluginId` and `Scope`, so every
 * registration is owned by the plugin and collected when its scope closes.
 */
export const makeHost = (
	registries: HostRegistries,
	pluginId: string,
	scope: Scope.Scope,
): Host => ({
	// The app version comes from Tauri's asynchronous `getVersion()`, which a
	// synchronous host cannot read — and the web build has no shell to ask, the
	// same reason `state/updates.ts` folds a failed version read to `null`. An
	// empty value is unparsable, and the loader's `engines.app` check treats an
	// unparsable bound as a warning, never a refusal.
	version: { app: "", api: pluginApiVersion },
	ui: makeContributionRegistry(registries.ui, pluginId, scope),
	commands: makeHostRegistry(registries.commands, pluginId, scope),
	settings: makeHostRegistry(registries.settings, pluginId, scope),
	tools: makeHostRegistry(registries.tools, pluginId, scope),
	providers: makeHostRegistry(registries.providers, pluginId, scope),
	pipeline: makeHostRegistry(registries.pipeline, pluginId, scope),
	renderers: makeHostRegistry(registries.renderers, pluginId, scope),
	themes: makeHostRegistry(registries.themes, pluginId, scope),
});

/**
 * The host service layer (spec §3): every registry is created here, once, so
 * the runtime that consumes this layer is the one place registries come from.
 */
export const HostLayer: Layer.Layer<HostServices> = Layer.effect(
	HostServices,
	Effect.gen(function* () {
		return {
			ui: yield* makeRegistry<Contribution>("ui"),
			tools: yield* makeRegistry<RegistryEntry>("tools"),
			providers: yield* makeRegistry<RegistryEntry>("providers"),
			pipeline: yield* makeRegistry<RegistryEntry>("pipeline"),
			commands: yield* makeRegistry<RegistryEntry>("commands"),
			keybindings: yield* makeRegistry<RegistryEntry>("keybindings"),
			settings: yield* makeRegistry<RegistryEntry>("settings"),
			renderers: yield* makeRegistry<RegistryEntry>("renderers"),
			themes: yield* makeRegistry<RegistryEntry>("themes"),
		} satisfies HostRegistries;
	}),
);
