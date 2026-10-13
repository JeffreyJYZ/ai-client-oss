import { afterEach, describe, expect, test } from "bun:test";
import { webInstaller } from "@lib/plugins/install";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { DB_NAME, DB_VERSION, web } from "@lib/plugins/source/web";
import { Effect } from "effect";

/**
 * The web plugin source and the web installer are the two halves of one
 * database: one IndexedDB, one object store, one upgrade. These tests drive
 * both real halves against a fake `indexedDB` — the same seam
 * `lib/plugins/builtin/commands.test.ts` installs — rather than mocking a
 * project module, so the subject is the code itself.
 *
 * **The order of the tests in this file is load-bearing.** A *successful* open
 * is memoized for the life of the process — one page holds one connection per
 * database — while a failed one is not. So a test that needs the store to be
 * unopenable has to run *before* the first test that opens it successfully;
 * anything else can go anywhere.
 *
 * The fake models the two behaviours that carry the assertions: `onupgradeneeded`
 * fires exactly when the requested version is newer than the database's (so the
 * store really is created by the app's own handler) and a transaction against a
 * store that does not exist throws, as IndexedDB does.
 */

/** One installed record, as the app hands it to the store. */
interface FakeRecord {
	readonly id: unknown;
}

/** The database behind the fake, shared by every connection to it. */
interface FakeDatabase {
	readonly records: Map<string, unknown>;
	readonly stores: Set<string>;
	version: number | undefined;
}

/** One `indexedDB.open` call, recorded so the test can count and inspect it. */
interface OpenCall {
	readonly name: string;
	readonly version: number;
}

interface FakeRequest<T> {
	result: T;
	error: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
}

const freshDatabase = (): FakeDatabase => ({
	records: new Map<string, unknown>(),
	stores: new Set<string>(),
	version: undefined,
});

const request = <T>(result: T): FakeRequest<T> => ({
	result,
	error: null,
	onsuccess: null,
	onerror: null,
});

/**
 * The store handle for one transaction. Every request resolves on a microtask,
 * request first and then the transaction's `complete` — the order the two
 * halves depend on (`install.ts` resolves on commit, the reader on the request).
 */
const storeHandle = (
	database: FakeDatabase,
	transaction: { oncomplete: (() => void) | null },
) => {
	const settle = (
		req: FakeRequest<unknown>,
		mutate?: () => void,
	): FakeRequest<unknown> => {
		queueMicrotask(() => {
			if (mutate !== undefined) mutate();
			req.onsuccess?.();
			queueMicrotask(() => transaction.oncomplete?.());
		});
		return req;
	};
	return {
		put: (record: FakeRecord) => {
			const req = request(undefined);
			return settle(req, () => database.records.set(String(record.id), record));
		},
		get: (id: string) => settle(request(database.records.get(String(id)))),
		getAll: () => settle(request([...database.records.values()])),
		delete: (id: string) => {
			const req = request(undefined);
			return settle(req, () => database.records.delete(String(id)));
		},
	};
};

let restoreIndexedDb = (): void => {};

/**
 * Install the fake as the page's `indexedDB`, returning the list it records
 * every open into. `failWith` makes every open fail with that error, which is
 * how the version mismatch is reproduced.
 */
const installIndexedDb = (
	database: FakeDatabase,
	failWith?: unknown,
): readonly OpenCall[] => {
	const calls: OpenCall[] = [];
	const globals = globalThis as { indexedDB?: unknown };
	const previous = globals.indexedDB;
	globals.indexedDB = {
		open: (name: string, version: number) => {
			calls.push({ name, version });
			const connection = {
				objectStoreNames: {
					contains: (store: string) => database.stores.has(store),
				},
				createObjectStore: (store: string) => {
					database.stores.add(store);
				},
				transaction: (store: string) => {
					if (!database.stores.has(store)) {
						throw new Error(`NotFoundError: no store named "${store}"`);
					}
					const transaction = {
						error: null as unknown,
						oncomplete: null as (() => void) | null,
						onerror: null as (() => void) | null,
						onabort: null as (() => void) | null,
						objectStore: () => storeHandle(database, transaction),
					};
					return transaction;
				},
			};
			const req: FakeRequest<unknown> & {
				onupgradeneeded: (() => void) | null;
			} = {
				...request(connection),
				error: failWith ?? null,
				onupgradeneeded: null,
			};
			queueMicrotask(() => {
				if (failWith !== undefined) {
					req.onerror?.();
					return;
				}
				if (database.version === undefined || version > database.version) {
					database.version = version;
					req.onupgradeneeded?.();
				}
				req.onsuccess?.();
			});
			return req;
		},
	};
	restoreIndexedDb = () => {
		globals.indexedDB = previous;
	};
	return calls;
};

afterEach(() => {
	restoreIndexedDb();
	restoreIndexedDb = (): void => {};
	clearLog();
});

describe("a plugin store the app cannot open", () => {
	/**
	 * The version mismatch the two open paths could drift into: the writer's
	 * `indexedDB.open` rejects with `VersionError`, and the reader swallows the
	 * failure to an empty list. The list stays empty — `PluginSource.list` has no
	 * error channel — but the reason must not be invisible, or an installed
	 * plugin "disappears" with nothing a user can report.
	 */
	test("is reported where the user can see it, not silently listed as nothing", async () => {
		const calls = installIndexedDb(
			freshDatabase(),
			new DOMException(
				"The requested version (1) is less than the existing version (2).",
				"VersionError",
			),
		);
		clearLog();

		const listed = await Effect.runPromise(web.list());
		const failure = await Effect.runPromise(
			Effect.flip(webInstaller.write("acme.hello", {}, {})),
		);
		const logged = getLogSnapshot()
			.map((line) => line.message)
			.join("\n");

		// The read half lists nothing rather than raising (its contract has no
		// error channel) …
		expect(listed).toEqual([]);
		expect(calls).toHaveLength(2);
		// … but the failure reaches the log panel the Plugins section renders,
		// naming the cause a user can quote.
		expect(logged).toContain("cannot list installed plugins");
		expect(logged).toContain("VersionError");
		// The write half is not silent either: it fails on its own channel.
		expect(failure.detail).toContain("VersionError");
	});
});

describe("the two halves of the web plugin store", () => {
	/**
	 * One database and one connection: the plugin log the write half wrote into
	 * is the same store the read half lists from, over a single `open` — and the
	 * upgrade handler ran once, creating the store the transactions then use.
	 */
	test("share one connection to one database, and a write is listed back", async () => {
		const calls = installIndexedDb(freshDatabase());

		const before = await Effect.runPromise(web.list());
		await Effect.runPromise(
			webInstaller.write(
				"acme.hello",
				{ name: "Hello" },
				{ "plugin.json": "{}", "main.js": "export default { setup() {} }" },
			),
		);
		const listed = await Effect.runPromise(web.list());
		const text = await Effect.runPromise(web.read("acme.hello", "main.js"));

		// One open for both halves, through the connection the reader's module
		// declares …
		expect(calls).toEqual([{ name: DB_NAME, version: DB_VERSION }]);
		// … and that database's persisted identity is pinned by value: renaming
		// it orphans every plugin a user already installed.
		expect(DB_NAME).toBe("ai-client-plugins");
		expect(DB_VERSION).toBe(1);
		expect(before).toEqual([]);
		expect(listed).toEqual([{ name: "Hello" }]);
		expect(text).toContain("setup");
	});
});
