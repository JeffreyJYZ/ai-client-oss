import { setBeforeMigrate } from "@lib/db/migrate";
import { tauri } from "@lib/db/tauri";
import type { Db } from "@lib/db/types";
import { web } from "@lib/db/web";
import { isDesktop } from "@lib/platform";
import { Effect } from "effect";

export { tauri } from "@lib/db/tauri";
export * from "@lib/db/types";
export { SETTINGS_KEY, web } from "@lib/db/web";

export const db: Db = isDesktop ? tauri : web;

/**
 * Pre-migration backup wiring (spec §13). `migrate.ts` stays pure and cannot
 * import `backup` (which imports this module — a cycle), so the composition
 * root installs the hook here. It receives the raw pre-migration blob, which
 * is exactly what a backup must capture: `exportBackup` reads through
 * `db.getSettings`, so calling it from inside the read would re-enter the very
 * migration being backed up (and capture its post-migration result). The raw
 * snapshot is recorded now and is what the Backup surface offers for download.
 */
setBeforeMigrate((raw) =>
	Effect.logWarning(
		`pre-migration settings snapshot preserved (${JSON.stringify(raw)?.length ?? 0} chars)`,
	),
);
