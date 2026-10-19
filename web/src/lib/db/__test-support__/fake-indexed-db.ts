/**
 * Test-support for the browser adapter's conversation store: a minimal
 * `indexedDB` stand-in, enough for `@lib/db/web`'s one object store.
 *
 * The suite needs a *raw* row in the store — one the schema has to degrade —
 * and the adapter offers no other way in: `upsertConversation` takes a
 * `Conversation`, so a value outside the enum can only enter the store behind
 * the parser. Installing this as the page's `indexedDB` (the seam
 * `lib/plugins/source/web.test.ts` uses for the plugin store) is the smallest way
 * to reach the adapter's own listing path with such a row.
 *
 * Never imported by app code, and the name does not match `*.test.ts`, so bun
 * does not run it as a suite.
 */

/** One request handle: the adapter settles on `onsuccess`/`onerror`. */
interface FakeRequest<T> {
	result: T;
	error: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
}

/** The store the adapter reads and writes, and the way back to the real global. */
export interface ConversationStore {
	/** Replace the store's contents with these raw rows; nothing is validated. */
	seed(rows: readonly Record<string, unknown>[]): void;
	/**
	 * Put the previous `indexedDB` global (usually `undefined`) back, and empty
	 * the store first: `web.ts` memoizes its connection **process-wide**, so a
	 * later suite in the same process reads through this store rather than
	 * opening its own. Empty leaves such a reader what a failed open leaves it —
	 * no conversations — instead of this suite's rows.
	 */
	restore(): void;
}

const request = <T>(result: T): FakeRequest<T> => ({
	result,
	error: null,
	onsuccess: null,
	onerror: null,
});

/**
 * Install an `indexedDB` whose single object store is `records`, upgrading on
 * the way in exactly as `web.ts` expects (`onupgradeneeded` first, then
 * `onsuccess`), and every request resolving on a microtask like the real one.
 */
export const installConversationStore = (): ConversationStore => {
	const records = new Map<string, unknown>();
	const stores = new Set<string>();
	const globals = globalThis as { indexedDB?: unknown };
	const previous = globals.indexedDB;
	let version: number | undefined;

	const settle = (
		req: FakeRequest<unknown>,
		mutate: (() => void) | undefined,
		transaction: { oncomplete: (() => void) | null },
	): FakeRequest<unknown> => {
		queueMicrotask(() => {
			if (mutate !== undefined) mutate();
			req.onsuccess?.();
			queueMicrotask(() => transaction.oncomplete?.());
		});
		return req;
	};

	const storeHandle = (transaction: { oncomplete: (() => void) | null }) => ({
		put: (row: { readonly id: string }) =>
			settle(
				request(undefined),
				() => records.set(String(row.id), row),
				transaction,
			),
		get: (id: string) =>
			settle(request(records.get(String(id))), undefined, transaction),
		getAll: () =>
			settle(request([...records.values()]), undefined, transaction),
		delete: (id: string) =>
			settle(request(undefined), () => records.delete(String(id)), transaction),
	});

	globals.indexedDB = {
		open: (_name: string, openVersion: number) => {
			const connection = {
				objectStoreNames: {
					contains: (store: string) => stores.has(store),
				},
				createObjectStore: (store: string) => {
					stores.add(store);
				},
				// The store always exists by now: `open` upgraded first, and the
				// adapter's own `withStore` never asks for another one.
				transaction: () => {
					const transaction = {
						error: null as unknown,
						oncomplete: null as (() => void) | null,
						onabort: null as (() => void) | null,
						objectStore: () => storeHandle(transaction),
					};
					return transaction;
				},
			};
			const req: FakeRequest<unknown> & {
				onupgradeneeded: (() => void) | null;
			} = { ...request(connection), onupgradeneeded: null };
			queueMicrotask(() => {
				if (version === undefined || openVersion > version) {
					version = openVersion;
					req.onupgradeneeded?.();
				}
				req.onsuccess?.();
			});
			return req;
		},
	};

	return {
		seed: (rows) => {
			records.clear();
			for (const row of rows) records.set(String(row.id), row);
		},
		restore: () => {
			records.clear();
			globals.indexedDB = previous;
		},
	};
};
