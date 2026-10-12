import { type Db, db } from "@lib/db";
import { isDesktop } from "@lib/platform";
import { PluginFault } from "@lib/plugins/errors";
import { type HostEvent, type SlotId, slotIdSchema } from "@lib/plugins/ids";
import { makeNotifyService, type NotifyService } from "@lib/plugins/notify";
import {
	type Disposable,
	makeRegistry,
	type Registry,
	type RegistryEntry,
} from "@lib/plugins/registry";
import {
	makeRendererRegistry,
	type RendererRegistry,
} from "@lib/plugins/renderers";
import {
	type ChatService,
	type Logger,
	makeChatService,
	makeLogger,
	makeScopedStorage,
	type NativeHandle,
	nativeHandle,
	type ScopedStorage,
	subscribeHostEvent,
} from "@lib/plugins/services";
import {
	makeSettingsRegistry,
	type SettingsRegistry,
} from "@lib/plugins/settings";
import { makeToolRegistry, type ToolRegistry } from "@lib/plugins/tools";
import { runningVersion } from "@lib/updates";
import appPackage from "@root/package.json";
import {
	Context,
	Effect,
	Layer,
	type Option,
	Scope,
	type Stream,
} from "effect";
import type { ComponentType } from "react";

/**
 * The plugin API this build implements (spec §10). A plugin declares
 * `apiVersion` in its manifest; the loader refuses a different major and
 * warns on a different minor, so a plugin built against an older API is
 * told to rebuild rather than run against an API it never saw.
 */
export const pluginApiVersion = "0.1";

/**
 * The build's own version (spec §10) — the value `engines.app` is checked
 * against. `bump-version.ts` keeps `package.json` in lockstep with
 * `tauri.conf.json`, so this is a true version in every environment: the
 * browser bundle, the desktop shell, and tests. It is read rather than
 * inlined so the field can never go stale against the released build.
 */
export const buildAppVersion: string = appPackage.version;

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
 * Two kinds of member live here, deliberately split by signature. The
 * **synchronous registries** (`ui`, `commands`, `settings`, `tools`,
 * `providers`, `pipeline`, `renderers`, `themes`) register now and read as
 * Effects/Streams. The **services** a plugin calls for behaviour (`chat`, `db`,
 * `storage`, `notify`, `native`, `log`, `on`) are `services.ts`'s surface,
 * populated here per plugin: `chat`/`storage` are bound to this plugin, `db` is
 * the app's own adapter, and `notify`'s queue and `on`'s subscriptions die with
 * the plugin's `Scope`.
 */
export interface Host {
	/** The app and plugin-API versions a plugin is checked against (spec §10). */
	readonly version: { readonly app: string; readonly api: string };
	readonly ui: HostRegistry<Contribution>;
	readonly commands: HostRegistry<RegistryEntry>;
	readonly settings: SettingsRegistry;
	readonly tools: ToolRegistry;
	readonly providers: HostRegistry<RegistryEntry>;
	readonly pipeline: HostRegistry<RegistryEntry>;
	readonly renderers: RendererRegistry;
	readonly themes: HostRegistry<RegistryEntry>;
	/** The chat store, read and driven (spec §5). */
	readonly chat: ChatService;
	/** The app's own settings/conversation adapter (spec §5). */
	readonly db: Db;
	/** This plugin's key/value store, persisted into its `data` (spec §5). */
	readonly storage: ScopedStorage;
	/** Toasts, banners, confirms and modals rendered by the host (spec §5). */
	readonly notify: NotifyService;
	/** The desktop bridge, absent until Task 20 (spec §7). */
	readonly native: Option.Option<NativeHandle>;
	/** Scoped logging (spec §2). */
	readonly log: Logger;
	/** Subscribe to a host event; the handler stops when the plugin unloads. */
	readonly on: (
		event: HostEvent,
		handler: (payload: unknown) => void,
	) => Disposable;
}

/**
 * What `HostServices` provides: the versions the host reports, plus one
 * registry per kind (spec §3). Registries are created once in `HostLayer`'s
 * construction, so the whole app shares one collection per kind. The service
 * members that carry no per-plugin state (`chat`, `db`, `storage`, `on`, `log`,
 * `native`) are not held here — they live in `services.ts` and are bound per
 * plugin in `makeHost`. Neither `keybindings` nor `renderers` is a registry: a
 * command carries its own keybinding (`commands.ts` is the source of truth),
 * and a renderer is a `ui` contribution resolved through `useComponent`.
 *
 * The app version is host data, not a registry — it is resolved once at boot
 * (`runtime.ts` builds this layer), which is the only place with the async
 * Tauri read in hand, and carried here so `makeHost` can report it without a
 * parameter no later task could fill.
 */
export interface HostServicesShape {
	readonly version: { readonly app: string; readonly api: string };
	readonly ui: Registry<Contribution>;
	readonly tools: Registry<RegistryEntry>;
	readonly providers: Registry<RegistryEntry>;
	readonly pipeline: Registry<RegistryEntry>;
	readonly commands: Registry<RegistryEntry>;
	readonly settings: Registry<RegistryEntry>;
	readonly themes: Registry<RegistryEntry>;
}

/** The host service (spec §3): the versions and the registries, provided once at boot. */
export class HostServices extends Context.Service<
	HostServices,
	HostServicesShape
>()("HostServices") {}

/**
 * The running app version, resolved once at boot (spec §3/§10). Desktop asks
 * the Tauri shell (the same read the update check uses); the web build has no
 * shell to ask, and a failed shell read is no reason to report nothing, so
 * both fall back to the build's own version. Either way the field holds a true
 * version — never an empty string the loader would fail to parse.
 */
const resolveAppVersion = (): Effect.Effect<string> =>
	isDesktop
		? runningVersion().pipe(Effect.catch(() => Effect.succeed(buildAppVersion)))
		: Effect.succeed(buildAppVersion);

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
 * Attach `dispose` to the plugin's `Scope` for a handle that is not a registry
 * entry — an event subscription. The same `runSync` pairing as {@link attach}:
 * no interruption point sits between the subscription and its disposal, so
 * unload cannot miss it.
 */
const onUnload = (scope: Scope.Scope, dispose: () => void): void => {
	Effect.runSync(
		Effect.provideService(
			Scope.addFinalizer(scope, Effect.sync(dispose)),
			Scope.Scope,
			scope,
		),
	);
};

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
 * shared service plus that plugin's `pluginId` and `Scope`, so every
 * registration is owned by the plugin and collected when its scope closes, and
 * the version a plugin reads is the one the boot resolved.
 *
 * `settings` and `renderers` are typed views whose factory reads only
 * `host.ui`; the full `Host` literal does not exist until it is assembled, so
 * they are built from a view carrying that one member.
 */
export const makeHost = (
	services: HostServicesShape,
	pluginId: string,
	scope: Scope.Scope,
): Host => {
	const ui = makeContributionRegistry(services.ui, pluginId, scope);
	const uiView = { ui } as Host;
	return {
		version: services.version,
		ui,
		commands: makeHostRegistry(services.commands, pluginId, scope),
		settings: makeSettingsRegistry(uiView),
		tools: makeToolRegistry(
			makeHostRegistry(services.tools, pluginId, scope),
			pluginId,
		),
		providers: makeHostRegistry(services.providers, pluginId, scope),
		pipeline: makeHostRegistry(services.pipeline, pluginId, scope),
		renderers: makeRendererRegistry(uiView),
		themes: makeHostRegistry(services.themes, pluginId, scope),
		chat: makeChatService(),
		db,
		storage: makeScopedStorage(pluginId),
		notify: makeNotifyService(scope),
		native: nativeHandle,
		log: makeLogger(pluginId),
		on: (event, handler) => {
			const handle = subscribeHostEvent(event, handler, pluginId);
			onUnload(scope, handle.dispose);
			return handle;
		},
	};
};

/**
 * The host service layer (spec §3): the app version is resolved here, once,
 * and every registry is created here, once, so the runtime that consumes this
 * layer is the one place registries come from.
 */
export const HostLayer: Layer.Layer<HostServices> = Layer.effect(
	HostServices,
	Effect.gen(function* () {
		const app = yield* resolveAppVersion();
		return {
			version: { app, api: pluginApiVersion },
			ui: yield* makeRegistry<Contribution>("ui"),
			tools: yield* makeRegistry<RegistryEntry>("tools"),
			providers: yield* makeRegistry<RegistryEntry>("providers"),
			pipeline: yield* makeRegistry<RegistryEntry>("pipeline"),
			commands: yield* makeRegistry<RegistryEntry>("commands"),
			settings: yield* makeRegistry<RegistryEntry>("settings"),
			themes: yield* makeRegistry<RegistryEntry>("themes"),
		} satisfies HostServicesShape;
	}),
);
