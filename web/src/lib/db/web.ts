import { readSettings } from "@lib/db/read";
import {
	type Conversation,
	conversationSchema,
	type Db,
	REJECTED_SETTINGS_MESSAGE,
	Settings,
	settingsDefaults,
} from "@lib/db/types";
import { Effect, Option } from "effect";

const DB_NAME = "ai-client";
const DB_VERSION = 1;
const STORE = "conversations";

/** localStorage key for settings; also imported by the settings store. */
export const SETTINGS_KEY = "ai-client.settings";

/**
 * Raw text of the last stored blob that failed to parse, or `none` when the
 * store is readable. Set by a failed {@link getSettings}, cleared by a
 * successful read, a successful write, or {@link resetRejectedSettings}. This
 * is the whole preservation mechanism: while it is `some`, {@link setSettings}
 * refuses, so the stored value is never overwritten with defaults.
 */
let rejected: Option.Option<string> = Option.none();

/**
 * Open (creating on first run) the IndexedDB database. `Effect.callback` keeps
 * the callback-based Web API inside Effect without a raw `Promise`.
 */
const openDatabase = (): Effect.Effect<IDBDatabase, string> =>
	Effect.callback<IDBDatabase, string>((resume) => {
		if (typeof indexedDB === "undefined") {
			resume(Effect.fail("IndexedDB unavailable"));
			return;
		}
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE)) {
				database.createObjectStore(STORE, { keyPath: "id" });
			}
		};
		request.onsuccess = () => resume(Effect.succeed(request.result));
		request.onerror = () =>
			resume(Effect.fail(String(request.error ?? "IndexedDB open failed")));
	});

/** Memoized connection so every operation reuses one database handle. */
const cachedDatabase: Effect.Effect<Effect.Effect<IDBDatabase, string>> =
	Effect.cached(openDatabase());

/** Run one object-store request; every failure maps to a typed `string` error. */
const withStore = <A>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, string> =>
	Effect.gen(function* () {
		const open = yield* cachedDatabase;
		const database = yield* open;
		// `database.transaction` / `objectStore` are synchronous Web APIs that can
		// throw; `Effect.try` turns that throw into a typed `string` failure
		// instead of letting `Effect.callback` capture it as a defect.
		const { transaction, request } = yield* Effect.try({
			try: () => {
				const transaction = database.transaction(STORE, mode);
				return { transaction, request: run(transaction.objectStore(STORE)) };
			},
			catch: (cause) => String(cause),
		});
		return yield* Effect.callback<A, string>((resume) => {
			request.onsuccess = () => resume(Effect.succeed(request.result));
			request.onerror = () =>
				resume(
					Effect.fail(String(request.error ?? "IndexedDB request failed")),
				);
			transaction.onabort = () =>
				resume(
					Effect.fail(
						String(transaction.error ?? "IndexedDB transaction aborted"),
					),
				);
		});
	});

const listConversations = (): Effect.Effect<Conversation[], string> =>
	Effect.map(
		withStore<unknown[]>("readonly", (store) => store.getAll()),
		(rows) =>
			rows.flatMap((row) => {
				const parsed = conversationSchema.safeParse(row);
				return parsed.success ? [parsed.data] : [];
			}),
	);

const getConversation = (
	id: string,
): Effect.Effect<Option.Option<Conversation>, string> =>
	Effect.map(
		withStore<unknown>("readonly", (store) => store.get(id)),
		(row) => {
			const parsed = conversationSchema.safeParse(row);
			return parsed.success ? Option.some(parsed.data) : Option.none();
		},
	);

const upsertConversation = (c: Conversation): Effect.Effect<void, string> =>
	Effect.asVoid(withStore("readwrite", (store) => store.put(c)));

const deleteConversation = (id: string): Effect.Effect<void, string> =>
	Effect.asVoid(withStore("readwrite", (store) => store.delete(id)));

const getSettings = (): Effect.Effect<Settings> =>
	Effect.orElseSucceed(
		Effect.gen(function* () {
			const raw = yield* Effect.try({
				try: () => localStorage.getItem(SETTINGS_KEY),
				catch: (cause) => String(cause),
			});
			const read = yield* readSettings(raw);
			if (read.kind === "rejected") {
				// Unreadable or unmigratable: keep the raw text so a write can
				// refuse, and run on in-memory defaults meanwhile. The stored
				// value is left untouched (spec §13).
				rejected = Option.some(read.raw);
				return settingsDefaults();
			}
			rejected = Option.none();
			return read.settings;
		}),
		() => settingsDefaults(),
	);

const rejectedSettings = (): Effect.Effect<Option.Option<string>> =>
	Effect.sync(() => rejected);

const resetRejectedSettings = (): Effect.Effect<void> =>
	Effect.sync(() => {
		rejected = Option.none();
	});

const setSettings = (patch: Partial<Settings>): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		if (Option.isSome(rejected)) {
			return yield* Effect.fail(REJECTED_SETTINGS_MESSAGE);
		}
		const current = yield* getSettings();
		const parsed = Settings.safeParse({ ...current, ...patch });
		if (!parsed.success) return yield* Effect.fail("invalid settings");
		yield* Effect.try({
			try: () => {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed.data));
			},
			catch: (cause) => String(cause),
		});
		// The store now holds valid settings, so nothing is outstanding.
		rejected = Option.none();
	});

export const web: Db = {
	listConversations,
	getConversation,
	upsertConversation,
	deleteConversation,
	getSettings,
	rejectedSettings,
	resetRejectedSettings,
	setSettings,
};
