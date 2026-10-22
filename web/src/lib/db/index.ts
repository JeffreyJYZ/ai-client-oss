import { companionDb } from "@lib/db/companion";
import { setPreMigrationCapture } from "@lib/db/read";
import { tauri } from "@lib/db/tauri";
import type { Db } from "@lib/db/types";
import { web } from "@lib/db/web";
import { isDesktop } from "@lib/platform";
import { Effect } from "effect";

export { tauri } from "@lib/db/tauri";
export * from "@lib/db/types";
export { SETTINGS_KEY, web } from "@lib/db/web";

export const db: Db = isDesktop ? tauri : companionDb(web);

/**
 * Raw text of the last pre-migration settings blob, or `null` when no
 * migration has run. Handed to the Backup surface (Settings → Backup) so the
 * user can download the pre-migration state (spec §13). In-memory only: a
 * durable, file-backed snapshot would need a general desktop file-write
 * command, and the native bridge exposes only plugin-scoped writes (T20).
 * The registry now carries the memory migration, so any blob below
 * `DATA_VERSION` captures here — the only case that fires.
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
