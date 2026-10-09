import {
	type Conversation,
	conversationSchema,
	type Db,
	Settings,
	settingsDefaults,
} from "@lib/db/types";
import { Effect } from "effect";

const DB_NAME = "ai-client";
const DB_VERSION = 1;
const STORE = "conversations";

/** localStorage key for settings; also imported by the settings store. */
export const SETTINGS_KEY = "ai-client.settings";

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
		return yield* Effect.callback<A, string>((resume) => {
			const transaction = database.transaction(STORE, mode);
			const request = run(transaction.objectStore(STORE));
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
): Effect.Effect<Conversation | undefined, string> =>
	Effect.map(
		withStore<unknown>("readonly", (store) => store.get(id)),
		(row) => {
			const parsed = conversationSchema.safeParse(row);
			return parsed.success ? parsed.data : undefined;
		},
	);

const upsertConversation = (c: Conversation): Effect.Effect<void, string> =>
	Effect.asVoid(withStore("readwrite", (store) => store.put(c)));

const deleteConversation = (id: string): Effect.Effect<void, string> =>
	Effect.asVoid(withStore("readwrite", (store) => store.delete(id)));

const getSettings = (): Effect.Effect<Settings> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => {
				const raw = localStorage.getItem(SETTINGS_KEY);
				if (raw === null) return settingsDefaults();
				const parsed = Settings.safeParse(JSON.parse(raw));
				return parsed.success ? parsed.data : settingsDefaults();
			},
			catch: () => "settings read failed",
		}),
		() => settingsDefaults(),
	);

const setSettings = (patch: Partial<Settings>): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		const current = yield* getSettings();
		const parsed = Settings.safeParse({ ...current, ...patch });
		if (!parsed.success) return yield* Effect.fail("invalid settings");
		return yield* Effect.try({
			try: () => {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed.data));
			},
			catch: (cause) => String(cause),
		});
	});

export const web: Db = {
	listConversations,
	getConversation,
	upsertConversation,
	deleteConversation,
	getSettings,
	setSettings,
};
