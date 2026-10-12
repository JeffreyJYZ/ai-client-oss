import { describe, expect, mock, test } from "bun:test";
import type { Migration } from "@lib/db/migrate";
import * as migrationsModule from "@lib/db/migrate";
import {
	DATA_VERSION,
	dataVersionOf,
	MIGRATION_FAILED_MESSAGE,
	migrateSettings,
	migrations,
	pendingMigrations,
} from "@lib/db/migrate";
import { emptyProviderConfig, Settings, settingsDefaults } from "@lib/db/types";
import {
	PLUGIN_DATA_MAX_BYTES,
	pluginDataWithinCap,
} from "@lib/plugins/manifest";
import { Effect, Option, Result } from "effect";

const run = <A>(effect: Effect.Effect<A, string>): Promise<A> =>
	Effect.runPromise(effect);

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

	test("the pre-migration backup runs once, before the first migration", async () => {
		const order: string[] = [];
		const only: Migration = {
			to: 1,
			run: (input) => {
				order.push("migrate");
				return input;
			},
		};
		await run(
			migrateSettings({}, [only], () =>
				Effect.sync(() => {
					order.push("backup");
				}),
			),
		);
		expect(order).toEqual(["backup", "migrate"]);
	});

	test("a failing backup is logged and does not block the migration", async () => {
		const only: Migration = { to: 1, run: () => ({ providers: [] }) };
		const out = await run(
			migrateSettings({}, [only], () => Effect.fail("no disk space")),
		);
		expect(Settings.parse(out).dataVersion).toBe(1);
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

// Captured before the mock below swaps the module's exports: the live binding
// the mock installs would otherwise hide what actually ships.
const shippedMigrations = [...migrations];

// The adapters read the registry from `@lib/db/migrate`; inject a faulting one
// so the real engine runs and the adapter's failure mapping is proven. This
// must run before the adapter is imported, so the mock installs it here.
const faulting: Migration = {
	to: 1,
	run: () => {
		throw new Error("boom");
	},
};
mock.module("@lib/db/migrate", () => ({
	...migrationsModule,
	migrations: [faulting],
}));
const { web, SETTINGS_KEY } = await import("@lib/db/web");

const seed = (
	value: string,
): { raw: () => string | null; writes: () => number } => {
	const map = new Map<string, string>([[SETTINGS_KEY, value]]);
	let writes = 0;
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, next: string) => {
			writes += 1;
			map.set(key, next);
		},
		removeItem: (key: string) => map.delete(key),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		},
	} as unknown as Storage;
	return {
		raw: () => map.get(SETTINGS_KEY) ?? null,
		writes: () => writes,
	};
};

describe("adapters — a faulting migration is a rejection, not a wipe", () => {
	test("getSettings reports defaults, keeps the blob and raises the rejection", async () => {
		const blob = JSON.stringify({ providers: [{ id: "kept" }] });
		const store = seed(blob);

		expect(await run(web.getSettings())).toEqual(settingsDefaults());
		expect(store.raw()).toBe(blob);
		expect(store.writes()).toBe(0);
		const rejected = await run(web.rejectedSettings());
		expect(Option.isSome(rejected)).toBe(true);
	});

	test("setSettings then refuses, leaving the blob byte-identical", async () => {
		const blob = JSON.stringify({ providers: [{ id: "kept" }] });
		const store = seed(blob);
		await run(web.getSettings());

		const result = await Effect.runPromise(
			Effect.result(web.setSettings({ memoriesEnabled: false })),
		);
		expect(Result.isFailure(result)).toBe(true);
		expect(store.raw()).toBe(blob);
		expect(store.writes()).toBe(0);

		await run(web.resetRejectedSettings());
	});
});
