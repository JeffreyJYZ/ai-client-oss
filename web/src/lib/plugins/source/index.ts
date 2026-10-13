import { isDesktop } from "@lib/platform";
import type { PluginSource } from "@lib/plugins/loader";
import { tauri } from "@lib/plugins/source/tauri";
import { web } from "@lib/plugins/source/web";

export { tauri } from "@lib/plugins/source/tauri";
export { web } from "@lib/plugins/source/web";

/**
 * The platform's `PluginSource` (spec §6): the one place the loader's source
 * dependency is chosen, exactly as `lib/db/index.ts` chooses its adapter. The
 * desktop reads installed plugins from the file system (`<app data>/plugins/`);
 * the web build reads IndexedDB ({@link web}). The loader and everything above
 * it never learn which platform they are on.
 */
export const pluginSource: PluginSource = isDesktop ? tauri : web;
