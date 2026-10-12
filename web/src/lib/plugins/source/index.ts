import type { PluginSource } from "@lib/plugins/loader";
import { web } from "@lib/plugins/source/web";

/**
 * The platform's `PluginSource` (spec §6): the one place the loader's source
 * dependency is chosen. Web builds read installed plugins from IndexedDB
 * ({@link web}); Task 20 adds the Tauri adapter (the desktop's file system) and
 * branches on `isDesktop` right here, so the loader and everything above it
 * never learn which platform they are on.
 */
export const pluginSource: PluginSource = web;
