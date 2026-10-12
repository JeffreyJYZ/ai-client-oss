import {
	type Migration,
	migrateSettings,
	migrations,
	pendingMigrations,
} from "@lib/db/migrate";
import { Settings, settingsDefaults } from "@lib/db/types";
import { Effect, Result } from "effect";

/**
 * Outcome of reading the stored settings blob: parsed settings, or the raw
 * text that must be preserved and reported (spec §13's safety net). A caller
 * that gets `rejected` keeps `raw` untouched, refuses writes and runs on
 * in-memory defaults — a parse *or* migration fault is never a default-and-wipe.
 */
export type SettingsRead =
	| { readonly kind: "ok"; readonly settings: Settings }
	| { readonly kind: "rejected"; readonly raw: string };

/**
 * Called with the raw pre-migration blob just before a migration rewrites it,
 * so the composition root can hand it to the Backup surface. Its failure is
 * logged and never blocks the read.
 */
export type PreMigrationCapture = (raw: string) => Effect.Effect<void, string>;

let capture: PreMigrationCapture | undefined;

/**
 * Install (or clear) the pre-migration capture hook. Returns the previous hook
 * so a caller (a test) can restore it. Wiring lives at the composition root
 * (`db/index.ts`), never here.
 */
export const setPreMigrationCapture = (
	hook: PreMigrationCapture | undefined,
): PreMigrationCapture | undefined => {
	const previous = capture;
	capture = hook;
	return previous;
};

/** Parse a stored string, degrading malformed JSON to `undefined`. */
const parseJson = (raw: string): Effect.Effect<unknown> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: () => "invalid json",
		}),
		() => undefined,
	);

/**
 * The read-then-migrate step both adapters share. `raw` is the stored text
 * (`null` when nothing is stored). A migration that faults, or a blob the
 * current schema still cannot parse, reports `rejected` carrying the untouched
 * raw text so the caller preserves it and refuses writes (Task 0.1's net).
 * `registry` is injectable so the fault path is testable without mocking a
 * module.
 */
export const readSettings = (
	raw: string | null,
	registry: readonly Migration[] = migrations,
): Effect.Effect<SettingsRead> =>
	Effect.gen(function* () {
		if (raw === null) {
			return { kind: "ok", settings: settingsDefaults() } as const;
		}
		const data = yield* parseJson(raw);
		// Snapshot the raw pre-migration blob before any migration rewrites it.
		// Taken here because the stored bytes are in hand; `migrateSettings`
		// stays pure and `backup` is never called from inside the read.
		if (pendingMigrations(data, registry).length > 0 && capture !== undefined) {
			yield* Effect.catch(capture(raw), (cause) =>
				Effect.logWarning(`pre-migration capture failed: ${cause}`),
			);
		}
		const migration = yield* Effect.result(migrateSettings(data, registry));
		if (Result.isFailure(migration)) {
			return { kind: "rejected", raw } as const;
		}
		const parsed = Settings.safeParse(migration.success);
		if (parsed.success) {
			return { kind: "ok", settings: parsed.data } as const;
		}
		return { kind: "rejected", raw } as const;
	});
