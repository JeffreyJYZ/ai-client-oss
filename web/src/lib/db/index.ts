import { tauri } from "@lib/db/tauri";
import type { Db } from "@lib/db/types";
import { web } from "@lib/db/web";
import { isDesktop } from "@lib/platform";

export { tauri } from "@lib/db/tauri";
export * from "@lib/db/types";
export { SETTINGS_KEY, web } from "@lib/db/web";

export const db: Db = isDesktop ? tauri : web;
