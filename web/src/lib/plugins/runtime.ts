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
