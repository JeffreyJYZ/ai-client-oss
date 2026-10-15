import type { MemoryEntry } from "@lib/memoryNotes";
import { Effect } from "effect";

/**
 * Current persisted `Settings` schema version. Bumped only when a change
 * cannot be expressed as an additive zod default, and every bump ships a
 * migration in {@link migrations} that carries an older blob up to it.
 */
export const DATA_VERSION = 2;

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
 * The migration's slug ceiling, mirroring `MEMORY_ID_PATTERN`'s own ceiling
 * (`[a-z0-9]` then `{0,63}` — 64 characters). A generated id that fails its
 * own allowlist is an id no tool could ever address, so the two are pinned
 * together by the migration's tests (real ids asserted against the pattern).
 */
export const MEMORY_ID_MAX_LENGTH = 64;

/** Base id for a note whose content yields no slug characters at all. */
const EMPTY_SLUG_BASE = "note";

/**
 * Slug of a note's content: lowercase, every run of characters outside
 * `[a-z0-9._-]` collapsed to one `-`, the leading run stripped so the first
 * character is alphanumeric, the length capped, and any trailing separator
 * removed — a legal id before dedupe. Empty → {@link EMPTY_SLUG_BASE}.
 */
const slugBase = (text: string): string => {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, MEMORY_ID_MAX_LENGTH)
		.replace(/[-._]+$/, "");
	return slug.length > 0 ? slug : EMPTY_SLUG_BASE;
};

/** `base` with a `-n` suffix, truncated so the whole id still fits the ceiling. */
const withNumericSuffix = (base: string, n: number): string => {
	const suffix = `-${n}`;
	return `${base.slice(0, MEMORY_ID_MAX_LENGTH - suffix.length)}${suffix}`;
};

/**
 * `base`, or `base-2`, `base-3`, … — the first form `used` has not taken.
 * Deterministic, so the same input always yields the same ids.
 */
const uniqueId = (base: string, used: ReadonlySet<string>): string => {
	if (!used.has(base)) return base;
	let n = 2;
	let candidate = withNumericSuffix(base, n);
	while (used.has(candidate)) {
		n += 1;
		candidate = withNumericSuffix(base, n);
	}
	return candidate;
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** One note seeded from a legacy `memories` entry; `undefined` when the entry
 *  is not a legacy note (nothing with a string `text`). */
const migrateLegacyEntry = (
	entry: unknown,
	used: Set<string>,
): MemoryEntry | undefined => {
	const note = asObject(entry);
	if (note === undefined) return undefined;
	const text = note.text;
	if (typeof text !== "string") return undefined;
	// Legacy notes always carry `createdAt`. A missing one reads as 0 — never a
	// clock read, which would make two runs of this pure transform differ.
	const createdAt = typeof note.createdAt === "number" ? note.createdAt : 0;
	const id = uniqueId(slugBase(text), used);
	used.add(id);
	return { id, content: text, updatedAt: createdAt, history: [] };
};

/**
 * The first real migration: seed `memoryNotes` from the legacy `memories`
 * array — one note per memory, with a slug id derived from its content
 * (deduped with `-2`, `-3`, … on collision), the legacy note's own `createdAt`
 * as `updatedAt`, and an empty history because nothing has been changed yet.
 *
 * Additive and pure: `memories` and every other stored field pass through
 * untouched, and a blob that already carries a `memoryNotes` array is returned
 * as-is — those notes exist already, and re-deriving them would suffix-collide
 * them into duplicates, so the transform stays a fixed point.
 */
export const migrateLegacyMemories = (input: unknown): unknown => {
	const blob = asObject(input);
	if (blob === undefined) return input;
	if (Array.isArray(blob.memoryNotes)) return input;
	const used = new Set<string>();
	const legacy = Array.isArray(blob.memories) ? blob.memories : [];
	const memoryNotes = legacy.flatMap((entry) => {
		const note = migrateLegacyEntry(entry, used);
		return note === undefined ? [] : [note];
	});
	return { ...blob, memoryNotes };
};

/**
 * Registered migrations, applied ascending by `to` to any stored blob whose
 * `dataVersion` is below theirs, each exactly once per read. The memory
 * migration is the first real member: it seeds `memoryNotes` from the legacy
 * array. Add a member only alongside a real, breaking change.
 */
export const migrations: readonly Migration[] = [
	{ to: 2, run: migrateLegacyMemories },
];

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
