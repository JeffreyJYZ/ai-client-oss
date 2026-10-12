import { setPreMigrationCapture } from "@lib/db/read";
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
 * Raw text of the last pre-migration settings blob, or `null` when no
 * migration has run. Handed to the Backup surface (Settings → Backup) so the
 * user can download the pre-migration state (spec §13). In-memory only: a
 * durable, file-backed snapshot needs a desktop file-write command, which does
 * not exist yet (T20). Today the registry is empty, so no capture fires.
 */
let preMigrationCapture: string | null = null;

/** The captured pre-migration blob, or `null`. Read by the Backup section. */
export const getPreMigrationCapture = (): string | null => preMigrationCapture;

/** Drop the capture once the user has downloaded it. */
export const clearPreMigrationCapture = (): void => {
	preMigrationCapture = null;
};

/**
 * Take the capture at the composition root. `read.ts` hands over the raw stored
 * bytes before the migration that would rewrite them; the capture is never
 * taken by re-entering `getSettings` (that recurses unboundedly and would see
 * already-migrated state).
 */
setPreMigrationCapture((raw) =>
	Effect.sync(() => {
		preMigrationCapture = raw;
	}),
);
