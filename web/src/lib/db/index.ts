import { tauri } from "@lib/db/tauri";
import type { Db } from "@lib/db/types";
import { web } from "@lib/db/web";

export { tauri } from "@lib/db/tauri";
export * from "@lib/db/types";
export { SETTINGS_KEY, web } from "@lib/db/web";

export const db: Db = "__TAURI_INTERNALS__" in globalThis ? tauri : web;
