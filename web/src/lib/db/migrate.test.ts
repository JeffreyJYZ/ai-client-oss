import { describe, expect, test } from "bun:test";
import { clearPreMigrationCapture, getPreMigrationCapture } from "@lib/db";
import type { Migration } from "@lib/db/migrate";
import {
	DATA_VERSION,
	dataVersionOf,
	MIGRATION_FAILED_MESSAGE,
	migrateSettings,
	migrations,
	pendingMigrations,
} from "@lib/db/migrate";
import { readSettings, setPreMigrationCapture } from "@lib/db/read";
import { emptyProviderConfig, Settings, settingsDefaults } from "@lib/db/types";
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

	test("the shipped registry is empty, so a pre-version blob is left to the zod default", async () => {
		expect(shippedMigrations).toEqual([]);
		const raw = { providers: [] };
		const out = await run(migrateSettings(raw, shippedMigrations));
		expect(out).toBe(raw);
		expect(Settings.parse(out).dataVersion).toBe(DATA_VERSION);
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

	test("a current blob parses through the shipped (empty) registry", async () => {
		const blob = JSON.stringify({
			...settingsDefaults(),
			memoriesEnabled: false,
		});
		const read = await run(readSettings(blob, shippedMigrations));
		expect(read.kind).toBe("ok");
		if (read.kind === "ok") expect(read.settings.memoriesEnabled).toBe(false);
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
