import { HostLayer } from "@lib/plugins/host";
import { ManagedRuntime } from "effect";

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
