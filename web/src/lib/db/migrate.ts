import { Effect } from "effect";

/**
 * Current persisted `Settings` schema version. Bumped only when a change
 * cannot be expressed as an additive zod default, and every bump ships a
 * migration in {@link migrations} that carries an older blob up to it.
 */
export const DATA_VERSION = 1;

/**
 * One step from a stored blob to a newer schema version.
 *
 * `to` is the version this migration produces (must exceed the version it
 * runs on) and orders the registry; `run` is a pure, idempotent transform of
 * the whole pre-migration blob into its post-migration shape.
 */
export interface Migration {
	readonly to: number;
	readonly run: (input: unknown) => unknown;
}

/**
 * Registered migrations, applied ascending by `to` to any stored blob whose
 * `dataVersion` is below theirs, each exactly once per read. **Empty for this
 * release**: the machinery is the deliverable and the next schema change is
 * what needs a member. Add one only alongside a real, breaking change.
 */
export const migrations: readonly Migration[] = [];

/**
 * Failure channel when a migration faults. The caller must treat this like a
 * parse failure (spec §13): keep the stored blob, raise the rejection, never
 * fall back to defaults.
 */
export const MIGRATION_FAILED_MESSAGE =
	"stored settings could not be migrated; the original was kept";

/**
 * Stored schema version of a raw blob: its own `dataVersion` when that is a
 * finite number, else `0` — a blob written before the field existed.
 */
export const dataVersionOf = (raw: unknown): number => {
	if (typeof raw !== "object" || raw === null) return 0;
	const value = (raw as { dataVersion?: unknown }).dataVersion;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** Migrations a blob still needs, ascending by `to`. Pure; no side effects. */
export const pendingMigrations = (
	raw: unknown,
	registry: readonly Migration[] = migrations,
): readonly Migration[] =>
	registry
		.filter((migration) => migration.to > dataVersionOf(raw))
		.sort((a, b) => a.to - b.to);

/**
 * Apply every pending migration to a raw blob, each exactly once, ascending.
 * `dataVersion` is stamped with each migration's `to`, so re-running over an
 * already-current blob applies nothing (idempotent); a blob at
 * {@link DATA_VERSION} passes through untouched.
 *
 * A migration that faults fails with {@link MIGRATION_FAILED_MESSAGE}: the
 * caller preserves the stored blob and raises the rejection rather than
 * defaulting. The pre-migration capture is deliberately not this module's job
 * — `db/read.ts` takes it (via the composition root) where the raw stored
 * bytes are in hand, which keeps this engine pure: no `db`, no `backup`, no
 * import cycle.
 */
export const migrateSettings = (
	raw: unknown,
	registry: readonly Migration[] = migrations,
): Effect.Effect<unknown, string> =>
	Effect.gen(function* () {
		const pending = pendingMigrations(raw, registry);
		if (pending.length === 0) return raw;
		let current = raw;
		for (const migration of pending) {
			const input = current;
			const migrated = yield* Effect.try({
				try: () => migration.run(input),
				catch: () => MIGRATION_FAILED_MESSAGE,
			});
			current =
				typeof migrated === "object" && migrated !== null
					? { ...migrated, dataVersion: migration.to }
					: migrated;
		}
		return current;
	});
