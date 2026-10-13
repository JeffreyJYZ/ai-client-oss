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
