import { isDesktop } from "@lib/platform";
import { PluginLoadFailed } from "@lib/plugins/errors";
import {
	type Host,
	HostLayer,
	HostServices,
	makeHost,
} from "@lib/plugins/host";
import { tauriInstaller, webInstaller } from "@lib/plugins/install";
import type {
	LoadDeps,
	ModuleImporter,
	PluginInstaller,
} from "@lib/plugins/loader";
import { moduleImporter } from "@lib/plugins/moduleImport";
import { pluginSource } from "@lib/plugins/source";
import { listen } from "@tauri-apps/api/event";
import { Effect, ManagedRuntime } from "effect";

/**
 * The subsystem's one runtime (spec §3), built from the host layer and created
 * at boot before React mounts. `web/src` is its only caller: React components
 * talk to the registries through the bridge (`useSyncExternalStore`), never by
 * running effects. Keeping a single runtime means every plugin shares one set
 * of registries — `HostLayer` is what creates them.
 */
export const runtime = ManagedRuntime.make(HostLayer);

export { moduleImporter } from "@lib/plugins/moduleImport";
/**
 * The load seams a plugin load is composed from (spec §6): the platform source
 * and the module importer. Both are re-exported here so the install surface
 * (Task 18) and the desktop adapter (Task 20) build their `LoadDeps` from one
 * place rather than reaching into `source/` and `moduleImport.ts` directly.
 * `moduleImporter` is a **factory** — it is bound to one plugin's `Host` so the
 * globals are set for that plugin, which is why it is not a static value.
 */
export { pluginSource } from "@lib/plugins/source";

/**
 * The Tauri event the desktop watcher (spec §6, `lib.rs`) emits when a plugin's
 * source changes. Rust owns the string; this is its one JS reader.
 */
export const PLUGIN_CHANGED_EVENT = "plugin-changed";

/** The desktop watcher's payload. `id` is untrusted: it crosses the IPC boundary. */
interface PluginChangedPayload {
	readonly id?: unknown;
}

/**
 * Subscribe to the desktop watcher's `plugin-changed` events (spec §6), calling
 * `handler` with the id of the plugin whose source changed, and return the
 * unsubscriber.
 *
 * On the web build there is no watcher — plugin source lives in IndexedDB and no
 * file-system change can happen under it — so this is a no-op that reports
 * nothing; the Plugins section's manual action is the web build's reload door.
 *
 * `listen` is a promise, so it is wrapped in `Effect` (the subsystem is Effect
 * all the way down, hence no `await`), and a failed subscription is a logged
 * warning rather than a throw: hot reload is a convenience and the app must run
 * without it. The payload is untrusted, so a missing or non-string `id` is
 * dropped rather than dispatched.
 */
export const subscribePluginChanges = (
	handler: (pluginId: string) => void,
): Effect.Effect<() => void> =>
	isDesktop
		? Effect.tryPromise({
				try: () =>
					listen<PluginChangedPayload>(PLUGIN_CHANGED_EVENT, (event) => {
						const id = event.payload?.id;
						if (typeof id === "string" && id !== "") handler(id);
					}),
				catch: (cause) =>
					new PluginLoadFailed({
						detail: `could not subscribe to "${PLUGIN_CHANGED_EVENT}": ${String(cause)}`,
					}),
			}).pipe(
				Effect.tapError((error) => Effect.logWarning(error)),
				Effect.map((unlisten): (() => void) => () => {
					void unlisten();
				}),
				Effect.orElseSucceed(() => () => {}),
			)
		: Effect.succeed(() => {});

/**
 * The install adapter (spec §6/§18), re-exported here for the same reason: one
 * place composes the platform halves, so the platform branch lives here and
 * nothing above it learns which one it got. Desktop installs through Task 20's
 * Rust file commands into `<app data>/plugins/<id>/`; the web build writes its
 * IndexedDB plugin store — each landing where that platform's `PluginSource`
 * reads, which is the only property that makes an install real.
 */
export const pluginInstaller: PluginInstaller = isDesktop
	? tauriInstaller
	: webInstaller;

/**
 * The loader's dependencies for one plugin load (spec §6). It reads the app
 * version and the registries out of the runtime, so a caller only needs
 * `runtime.runFork` around it.
 *
 * **The host/importer handshake, and why it is a closure.** `moduleImporter`
 * must be bound to the *host the loader builds for this plugin* — the globals it
 * sets are that plugin's `Host` — but the loader builds that host itself, inside
 * `hostFor`, and calls it before it reads or imports anything. So `hostFor`
 * captures the host here and the importer reads it back. That is one load at a
 * time, which is why the manager loads plugins serially; and the importer fails
 * loudly rather than importing against an unset global if the order ever
 * changes.
 */
export const loadDeps = (
	pluginId: string,
): Effect.Effect<LoadDeps, never, HostServices> =>
	Effect.gen(function* () {
		const services = yield* HostServices;
		let host: Host | undefined;

		const importer: ModuleImporter = {
			importSource: (source, name) =>
				host === undefined
					? Effect.fail(
							new PluginLoadFailed({
								detail: `plugin "${pluginId}" was imported before its host existed; the load was refused`,
								pluginId,
							}),
						)
					: moduleImporter(host, pluginId).importSource(source, name),
		};

		return {
			source: pluginSource,
			importer,
			hostFor: (id, scope) => {
				const built = makeHost(services, id, scope);
				host = built;
				return built;
			},
		} satisfies LoadDeps;
	});
