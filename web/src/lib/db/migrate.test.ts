import { describe, expect, test } from "bun:test";
import { clearPreMigrationCapture, getPreMigrationCapture } from "@lib/db";
import type { Migration } from "@lib/db/migrate";
import {
	DATA_VERSION,
	dataVersionOf,
	MEMORY_ID_MAX_LENGTH,
	MIGRATION_FAILED_MESSAGE,
	migrateSettings,
	migrations,
	pendingMigrations,
} from "@lib/db/migrate";
import { readSettings, setPreMigrationCapture } from "@lib/db/read";
import {
	emptyProviderConfig,
	memoryEntrySchema,
	Settings,
	settingsDefaults,
} from "@lib/db/types";
import { MEMORY_ID_PATTERN, type MemoryEntry } from "@lib/memoryNotes";
import {
	PLUGIN_DATA_MAX_BYTES,
	pluginDataWithinCap,
} from "@lib/plugins/manifest";
import { Effect, Logger, Result } from "effect";

/** The registry the app actually ships, snapshotted once. */
const shippedMigrations = [...migrations];

const run = <A>(effect: Effect.Effect<A, string>): Promise<A> =>
	Effect.runPromise(effect);

/** Run an effect with logging muted, for the deliberate capture failure. */
const runSilently = <A>(effect: Effect.Effect<A, string>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, Logger.layer([])));

describe("migrateSettings — pure engine", () => {
	test("a blob with no dataVersion and one at 0 both reach DATA_VERSION", async () => {
		const toCurrent: Migration = { to: DATA_VERSION, run: (input) => input };
		const withoutField = await run(
			migrateSettings({ providers: [] }, [toCurrent]),
		);
		const atZero = await run(
			migrateSettings({ providers: [], dataVersion: 0 }, [toCurrent]),
		);
		expect(Settings.parse(withoutField).dataVersion).toBe(DATA_VERSION);
		expect(Settings.parse(atZero).dataVersion).toBe(DATA_VERSION);
	});

	test("the shipped registry carries the memory migration, and an absent memoryNotes still defaults", async () => {
		expect(shippedMigrations.map((m) => m.to)).toEqual([DATA_VERSION]);
		const raw = { providers: [] };
		const out = await run(migrateSettings(raw, shippedMigrations));
		// Additively carried up to the current version by the new member.
		expect(dataVersionOf(out)).toBe(DATA_VERSION);
		expect(Settings.parse(out)).toMatchObject({ providers: [] });
		// The property the old empty-registry test protected, preserved: a
		// stored blob with no `memoryNotes` field still reads, via the zod
		// default, rather than failing or needing the field to exist.
		expect(Settings.parse(out).memoryNotes).toEqual([]);
	});

	test("a blob ahead of the current version passes through untouched", async () => {
		const raw = { providers: [], dataVersion: 99 };
		const out = await run(migrateSettings(raw, shippedMigrations));
		expect(out).toBe(raw);
		expect(Settings.parse(out).dataVersion).toBe(99);
	});

	test("runs each pending migration exactly once, in ascending order", async () => {
		const calls: string[] = [];
		const first: Migration = {
			to: 1,
			run: (input) => {
				calls.push("first");
				return { ...(input as object), first: true };
			},
		};
		const second: Migration = {
			to: 2,
			run: (input) => {
				calls.push("second");
				// Receives the first migration's output, not the raw blob.
				expect(input).toMatchObject({ first: true, dataVersion: 1 });
				return { ...(input as object), second: true };
			},
		};
		// Deliberately out of order in the registry.
		const out = await run(migrateSettings({}, [second, first]));
		expect(calls).toEqual(["first", "second"]);
		expect(out).toMatchObject({ first: true, second: true, dataVersion: 2 });
	});

	test("re-running over an already-current blob applies nothing (idempotent)", async () => {
		const calls: string[] = [];
		const only: Migration = {
			to: 1,
			run: (input) => {
				calls.push("ran");
				return input;
			},
		};
		const current = { providers: [], dataVersion: 1 };
		const out = await run(migrateSettings(current, [only]));
		expect(calls).toEqual([]);
		expect(out).toBe(current);
	});

	test("only migrations above the blob's dataVersion run", () => {
		const registry: Migration[] = [
			{ to: 1, run: (i) => i },
			{ to: 3, run: (i) => i },
		];
		expect(
			pendingMigrations({ dataVersion: 2 }, registry).map((m) => m.to),
		).toEqual([3]);
		expect(dataVersionOf({ dataVersion: 2 })).toBe(2);
		expect(dataVersionOf({})).toBe(0);
		expect(dataVersionOf({ dataVersion: "x" })).toBe(0);
		expect(dataVersionOf(null)).toBe(0);
	});

	test("a migration that faults leaves the blob untouched and reports", async () => {
		const faulting: Migration = {
			to: 1,
			run: () => {
				throw new Error("boom");
			},
		};
		const raw = { providers: [{ id: "kept" }] };
		const result = await Effect.runPromise(
			Effect.result(migrateSettings(raw, [faulting])),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBe(MIGRATION_FAILED_MESSAGE);
		}
		// Purity: the caller's blob object is never mutated.
		expect(raw).toEqual({ providers: [{ id: "kept" }] });
	});
});

describe("readSettings — the shared read-then-migrate step", () => {
	const rawBlob = JSON.stringify({ providers: [{ id: "kept" }] });

	test("a faulting migration is a rejection carrying the untouched raw text", async () => {
		const faulting: Migration = {
			to: 1,
			run: () => {
				throw new Error("boom");
			},
		};
		const read = await run(readSettings(rawBlob, [faulting]));
		// If the registry were ignored the blob would parse and this would be
		// `ok` — that is the discriminator.
		expect(read.kind).toBe("rejected");
		if (read.kind === "rejected") expect(read.raw).toBe(rawBlob);
	});

	test("a blob the current schema cannot parse is a rejection too", async () => {
		const blob = JSON.stringify({ providers: [{ id: 1 }] });
		const read = await run(readSettings(blob, shippedMigrations));
		expect(read.kind).toBe("rejected");
		if (read.kind === "rejected") expect(read.raw).toBe(blob);
	});

	test("nothing stored reads as defaults", async () => {
		const read = await run(readSettings(null));
		expect(read.kind).toBe("ok");
		if (read.kind === "ok") expect(read.settings).toEqual(settingsDefaults());
	});

	test("a current blob with no memoryNotes field parses through the shipped registry", async () => {
		// Drop the field to model a blob written before it existed, kept at the
		// current version so no migration runs: the zod default must supply it.
		const { memoryNotes, ...withoutNotes } = settingsDefaults();
		expect(memoryNotes).toEqual([]);
		const blob = JSON.stringify({
			...withoutNotes,
			memoriesEnabled: false,
		});
		const read = await run(readSettings(blob, shippedMigrations));
		expect(read.kind).toBe("ok");
		if (read.kind === "ok") {
			expect(read.settings.memoriesEnabled).toBe(false);
			expect(read.settings.memoryNotes).toEqual([]);
		}
	});
});

describe("pre-migration capture (spec §13)", () => {
	const toCurrent: Migration = { to: DATA_VERSION, run: (input) => input };
	const blob = JSON.stringify({ providers: [{ id: "kept" }] });

	test("a pending migration hands the raw pre-migration blob to the Backup surface", async () => {
		clearPreMigrationCapture();

		const read = await run(readSettings(blob, [toCurrent]));
		expect(read.kind).toBe("ok");

		// Produced and reachable: the exact stored bytes, not a re-serialised or
		// post-migration shape. An implementation that captured nothing (or the
		// migrated result) fails here.
		expect(getPreMigrationCapture()).toBe(blob);
	});

	test("the capture is the pre-migration bytes, not the migrated result", async () => {
		clearPreMigrationCapture();
		const rewriting: Migration = {
			to: DATA_VERSION,
			run: (input) => ({ ...(input as object), migrated: true }),
		};

		const read = await run(readSettings(blob, [rewriting]));
		expect(read.kind).toBe("ok");
		if (read.kind === "ok") expect(read.settings).toMatchObject({});

		const captured = getPreMigrationCapture();
		expect(captured).toBe(blob);
		expect(captured?.includes("migrated")).toBe(false);
	});

	test("no pending migration captures nothing", async () => {
		clearPreMigrationCapture();
		const current = JSON.stringify({
			providers: [],
			dataVersion: DATA_VERSION,
		});

		await run(readSettings(current, [toCurrent]));

		expect(getPreMigrationCapture()).toBeNull();
	});

	test("a failing capture is logged and does not block the migration", async () => {
		const previous = setPreMigrationCapture(() => Effect.fail("no disk space"));
		try {
			const read = await runSilently(readSettings(blob, [toCurrent]));
			expect(read.kind).toBe("ok");
			if (read.kind === "ok") {
				expect(read.settings.dataVersion).toBe(DATA_VERSION);
			}
		} finally {
			setPreMigrationCapture(previous);
		}
	});
});

describe("Settings per-field tolerance (spec §13)", () => {
	test("dataVersion defaults to the current version", () => {
		expect(Settings.parse({}).dataVersion).toBe(DATA_VERSION);
	});

	test("a missing protocol still gets today's default", () => {
		const parsed = Settings.parse({ providers: [{ id: "p" }] });
		expect(parsed.providers[0]?.protocol).toBe(
			emptyProviderConfig("p").protocol,
		);
	});

	test("a wrong-typed protocol degrades for that provider only — siblings survive", () => {
		const parsed = Settings.parse({
			providers: [
				{ id: "bad", protocol: 42, apiKey: "key-bad" },
				{ id: "good", protocol: "anthropic", apiKey: "key-good" },
			],
		});
		expect(parsed.providers[0]?.protocol).toBe(
			emptyProviderConfig("bad").protocol,
		);
		// The same provider's other fields are untouched.
		expect(parsed.providers[0]?.apiKey).toBe("key-bad");
		// The sibling provider is fully intact.
		expect(parsed.providers[1]?.protocol).toBe("anthropic");
		expect(parsed.providers[1]?.apiKey).toBe("key-good");
	});
});

describe("plugin data cap (spec §13, 'Plugin-owned data')", () => {
	test("a payload inside the cap passes and one over it fails", () => {
		expect(pluginDataWithinCap({ small: "value" })).toBe(true);
		const over = { blob: "x".repeat(PLUGIN_DATA_MAX_BYTES + 1) };
		expect(pluginDataWithinCap(over)).toBe(false);
	});

	test("a value that serialises to nothing is out of bounds", () => {
		expect(pluginDataWithinCap(undefined)).toBe(false);
	});
});

describe("the memory migration (the first real member of the registry)", () => {
	interface LegacyMemory {
		id: string;
		text: string;
		createdAt: number;
		source: "model" | "user";
	}

	const legacyMemory = (
		id: string,
		text: string,
		createdAt: number,
	): LegacyMemory => ({ id, text, createdAt, source: "user" });

	const legacyBlob = (memories: readonly LegacyMemory[]) => ({
		providers: [],
		memories,
	});

	test("memoryEntrySchema round-trips a MemoryEntry, dropping nothing", () => {
		const entry: MemoryEntry = {
			id: "a.b-c",
			content: "kept verbatim",
			updatedAt: 1234,
			deletedAt: 5678,
			history: [{ content: "older", at: 1000 }],
		};
		expect(memoryEntrySchema.parse(entry)).toEqual(entry);
		// A key the schema does not declare is stripped, so the exact key set
		// catches a schema that has drifted from T1's type.
		expect(Object.keys(memoryEntrySchema.parse(entry)).sort()).toEqual(
			Object.keys(entry).sort(),
		);
	});

	test("the slug ceiling is the pattern's own ceiling", () => {
		expect(MEMORY_ID_PATTERN.test("a".repeat(MEMORY_ID_MAX_LENGTH))).toBe(true);
		expect(MEMORY_ID_PATTERN.test("a".repeat(MEMORY_ID_MAX_LENGTH + 1))).toBe(
			false,
		);
	});

	test("an absent memoryNotes field reads as no notes, not a failure", () => {
		expect(Settings.parse({}).memoryNotes).toEqual([]);
		// The schema only defaults the field; it derives nothing. Seeding notes
		// from the legacy array is the migration's job, not the schema's.
		const legacyOnly = Settings.parse({
			memories: [legacyMemory("m1", "hello", 5)],
		});
		expect(legacyOnly.memoryNotes).toEqual([]);
		expect(legacyOnly.memories).toHaveLength(1);
	});

	test("a legacy-only blob migrates once into unique, slug-safe ids", async () => {
		const raw = legacyBlob([
			legacyMemory("m1", "User prefers bun over npm!", 1759900000000),
			// Identical content: the second id must be deduped, not repeated.
			legacyMemory("m2", "User prefers bun over npm!", 1759950000000),
			legacyMemory("m3", "Tabs at indentWidth 4.", 1760000000000),
		]);

		const notes = Settings.parse(
			await run(migrateSettings(raw, shippedMigrations)),
		).memoryNotes;
		expect(notes).toHaveLength(raw.memories.length);

		// The allowlist is the authority — merely-unique is not enough.
		for (const note of notes) {
			expect(MEMORY_ID_PATTERN.test(note.id)).toBe(true);
		}
		expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
		expect(notes.map((n) => n.id)).toEqual([
			"user-prefers-bun-over-npm",
			"user-prefers-bun-over-npm-2",
			"tabs-at-indentwidth-4",
		]);

		// Content carried over verbatim; `updatedAt` is the legacy note's own
		// `createdAt`, so a `Date.now()` read would fail this assertion.
		expect(notes.map((n) => n.content)).toEqual(
			raw.memories.map((m) => m.text),
		);
		expect(notes.map((n) => n.updatedAt)).toEqual(
			raw.memories.map((m) => m.createdAt),
		);
		expect(notes.every((n) => n.history.length === 0)).toBe(true);
		expect(notes.every((n) => n.deletedAt === undefined)).toBe(true);
	});

	test("a long or empty-content note still gets an id its own allowlist accepts", async () => {
		const longText = "a".repeat(120);
		const raw = legacyBlob([
			legacyMemory("m1", longText, 1),
			// Forces a suffix onto a slug already at the ceiling.
			legacyMemory("m2", longText, 2),
			legacyMemory("m3", "!!!", 3),
			legacyMemory("m4", "!!!", 4),
		]);

		const notes = Settings.parse(
			await run(migrateSettings(raw, shippedMigrations)),
		).memoryNotes;

		for (const note of notes) {
			expect(MEMORY_ID_PATTERN.test(note.id)).toBe(true);
		}
		// The suffix fits inside the ceiling: the base is truncated, not
		// overflowed (a naive `base + "-2"` is over the ceiling and fails the
		// pattern above).
		expect(notes[1]?.id.endsWith("-2")).toBe(true);
		expect(notes[1]?.id.length).toBe(notes[0]?.id.length);
		// An empty slug gets a constant base, never an invalid id.
		expect(notes[2]?.id).toBe("note");
		expect(notes[3]?.id).toBe("note-2");
	});

	test("running the migration again changes nothing", async () => {
		const raw = legacyBlob([
			legacyMemory("m1", "One fact.", 10),
			legacyMemory("m2", "One fact.", 20),
		]);

		const first = await run(migrateSettings(raw, shippedMigrations));
		// (a) Engine idempotence: the blob is stamped at DATA_VERSION, so the
		// second call finds nothing pending and returns the SAME object. This
		// proves no migration ran — a different reason from (b) below.
		const second = await run(migrateSettings(first, shippedMigrations));
		expect(dataVersionOf(second)).toBe(DATA_VERSION);
		expect(second).toBe(first);

		// (b) Transform stability — the "field was already there" case: the
		// shipped migration run directly over an already-migrated blob is a
		// fixed point, so re-deriving cannot suffix-collide a second time.
		const shipped = shippedMigrations.find((m) => m.to === DATA_VERSION);
		expect(shipped).toBeDefined();
		if (!shipped) return;
		expect(shipped.run(first)).toEqual(first);
	});

	test("a blob that already carries memoryNotes is a fixed point, even when one was edited", () => {
		// The guard is not a re-derivation: a blob below DATA_VERSION that already
		// carries `memoryNotes` must come back untouched. A no-guard transform
		// re-derives from `memories` and clobbers the edit below back to
		// "One fact." — and an UNEDITED input cannot pin this, because
		// re-derivation is byte-identical there, so part (b) above passes with or
		// without the guard. Only an edited note can tell the two apart.
		const shipped = shippedMigrations.find((m) => m.to === DATA_VERSION);
		expect(shipped).toBeDefined();
		if (!shipped) return;
		const edited = {
			...legacyBlob([legacyMemory("m1", "One fact.", 10)]),
			dataVersion: 1,
			memoryNotes: [
				{
					id: "one-fact",
					content: "EDITED BY USER",
					updatedAt: 99,
					history: [],
				},
			],
		};
		expect(shipped.run(edited)).toEqual(edited);
	});

	test("the legacy memories array is byte-identical, and nothing else is rewritten", async () => {
		const raw = legacyBlob([
			legacyMemory("m1", "First.", 1),
			legacyMemory("m2", "Second.", 2),
		]);

		const migrated = (await run(
			migrateSettings(raw, shippedMigrations),
		)) as Record<string, unknown>;

		// Whole-blob comparison: strip only the two keys the migration may add,
		// and what remains is the stored blob exactly.
		const { memoryNotes, dataVersion, ...rest } = migrated;
		expect(rest).toEqual(raw);
		expect(dataVersion).toBe(DATA_VERSION);
		expect(Array.isArray(memoryNotes)).toBe(true);

		// The legacy array alone, byte-for-byte.
		expect(JSON.stringify(migrated.memories)).toBe(
			JSON.stringify(raw.memories),
		);
	});
});
