import { mock } from "bun:test";
import { SETTINGS_KEY } from "@lib/db/web";
import { Result } from "effect";

/**
 * Shared test-support for the `db` suites. Never imported by app code, and the
 * file name deliberately does not match `*.test.ts`, so bun does not run it as
 * a suite of its own (it exports no tests).
 *
 * Only the third-party `@tauri-apps/api/core` is ever mocked — never a project
 * module (mocking one replaces its whole namespace process-wide) — and this is
 * the single fake both `safety.test.ts` and `compat.test.ts` register, so no two
 * competing fakes for one module can drift.
 */

/** Every Tauri command the fake `invoke` received, in order. */
export const invokeCalls: string[] = [];

let stored: string | null = null;

/** The raw string `db_get_settings` returns and `db_set_settings` stores. */
export const storedSettings = (): string | null => stored;

/** Seed the tauri adapter's storage for the next read. */
export const setStoredSettings = (raw: string | null): void => {
	stored = raw;
};

/** Zero the recorded command list. */
export const clearInvokeCalls = (): void => {
	invokeCalls.length = 0;
};

/**
 * Raw stored conversation rows, keyed by id: exactly the JSON strings the Rust
 * `db_list_conversations` serves and `db_upsert_conversation` receives. Seeded
 * by a suite through {@link setStoredConversations}, so a conversation can be
 * read back through the adapter's own listing path without an IndexedDB.
 */
const conversations = new Map<string, string>();

/**
 * Replace the desktop adapter's conversation store with `rows`, serialized the
 * way Rust stores them. Nothing is validated here: a row may deliberately carry
 * a value the schema has to degrade.
 */
export const setStoredConversations = (
	rows: readonly Record<string, unknown>[],
): void => {
	conversations.clear();
	for (const row of rows) {
		conversations.set(String(row.id), JSON.stringify(row));
	}
};

/**
 * The fake Tauri `invoke`: `db_get_settings` returns the seeded string and
 * `db_set_settings` records it, the conversation commands serve and store
 * {@link setStoredConversations}'s rows, and every other command resolves
 * `null`.
 */
export const fakeInvoke = mock(
	(command: string, args?: Record<string, unknown>) => {
		invokeCalls.push(command);
		if (command === "db_get_settings") return Promise.resolve(stored);
		if (command === "db_set_settings") {
			stored = String(args?.json ?? "");
			return Promise.resolve(null);
		}
		if (command === "db_list_conversations") {
			return Promise.resolve([...conversations.values()]);
		}
		if (command === "db_get_conversation") {
			return Promise.resolve(conversations.get(String(args?.id)) ?? null);
		}
		if (command === "db_upsert_conversation") {
			conversations.set(String(args?.id), String(args?.json ?? ""));
			return Promise.resolve(null);
		}
		return Promise.resolve(null);
	},
);

/** Outcome of `setSettings`, flattened so a test never names an effect type. */
export interface SetOutcome {
	readonly ok: boolean;
	readonly error?: string;
}

export const setOutcome = (result: Result.Result<void, string>): SetOutcome =>
	Result.isSuccess(result)
		? { ok: true }
		: { ok: false, error: result.failure };

/** Read access to an installed `localStorage` stand-in. */
export interface StorageAccess {
	readonly raw: () => string | null;
	readonly writes: () => number;
}

/**
 * Install a `localStorage` stand-in (on `globalThis`) seeded with `initial`,
 * and return the stored raw value plus the write count.
 */
export const installStorage = (initial: string | null): StorageAccess => {
	const map = new Map<string, string>();
	if (initial !== null) map.set(SETTINGS_KEY, initial);
	let writes = 0;
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: (key: string): string | null => map.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			writes += 1;
			map.set(key, value);
		},
		removeItem: (key: string): void => {
			map.delete(key);
		},
		clear: (): void => map.clear(),
		key: (): string | null => null,
		get length(): number {
			return map.size;
		},
	} as unknown as Storage;
	return {
		raw: (): string | null => map.get(SETTINGS_KEY) ?? null,
		writes: (): number => writes,
	};
};
