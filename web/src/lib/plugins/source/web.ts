import { PluginLoadFailed } from "@lib/plugins/errors";
import type { PluginSource } from "@lib/plugins/loader";
import { Effect } from "effect";

/**
 * The web `PluginSource` (spec §6): installed plugins live in an IndexedDB
 * store, `plugins`, whose records are `{ id, manifest, files }` — the raw
 * `plugin.json` value verbatim plus every file of the plugin keyed by its
 * relative path. Reading returns text; the loader decodes and imports it.
 *
 * A separate database from the app's conversations is deliberate: the app's
 * `ai-client` database is versioned by `lib/db/web.ts`, and adding a store to
 * it would couple every plugin install to that schema's version.
 *
 * `list` hands back the manifests **verbatim**, never parsed: an invalid
 * manifest has to reach the UI with its reason instead of vanishing here.
 */

const DB_NAME = "ai-client-plugins";
const DB_VERSION = 1;
/** The store's name — `records` are keyed by the plugin id. */
export const PLUGIN_STORE = "plugins";

/** One installed plugin's record, as it sits in IndexedDB. */
interface StoredPlugin {
	readonly id: string;
	readonly manifest: unknown;
	readonly files: Record<string, string>;
}

/**
 * Open (creating on first run) the plugin database. `Effect.callback` keeps the
 * callback-based Web API inside Effect — the repo pattern for IndexedDB
 * (`lib/db/web.ts`), never a raw `Promise`.
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
			if (!database.objectStoreNames.contains(PLUGIN_STORE)) {
				database.createObjectStore(PLUGIN_STORE, { keyPath: "id" });
			}
		};
		request.onsuccess = () => resume(Effect.succeed(request.result));
		request.onerror = () =>
			resume(Effect.fail(String(request.error ?? "IndexedDB open failed")));
	});

/** Memoized connection so every read reuses one database handle. */
const cachedDatabase: Effect.Effect<Effect.Effect<IDBDatabase, string>> =
	Effect.cached(openDatabase());

/** Run one read against the store; every failure maps to a typed `string`. */
const withStore = <A>(
	run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, string> =>
	Effect.gen(function* () {
		const open = yield* cachedDatabase;
		const database = yield* open;
		// `transaction`/`objectStore` are synchronous and can throw; `Effect.try`
		// makes that a typed failure rather than a defect inside `Effect.callback`.
		const { transaction, request } = yield* Effect.try({
			try: () => {
				const transaction = database.transaction(PLUGIN_STORE, "readonly");
				return {
					transaction,
					request: run(transaction.objectStore(PLUGIN_STORE)),
				};
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

const listRecords = (): Effect.Effect<readonly StoredPlugin[], string> =>
	withStore<StoredPlugin[]>((store) => store.getAll());

const readRecord = (
	id: string,
): Effect.Effect<StoredPlugin | undefined, string> =>
	withStore<StoredPlugin | undefined>((store) => store.get(id));

/** A read failure, or a missing file, as the loader's own error vocabulary. */
const loadFailed = (id: string, detail: string): PluginLoadFailed =>
	new PluginLoadFailed({ detail, pluginId: id });

export const web: PluginSource = {
	list: () =>
		listRecords().pipe(
			// `list` has no error channel by design (the loader lists what is
			// there); a store that cannot be read lists nothing, loudly.
			Effect.tapError((detail) =>
				Effect.logWarning(`plugins: cannot list installed plugins: ${detail}`),
			),
			Effect.orElseSucceed(() => [] as readonly StoredPlugin[]),
			Effect.map((records) => records.map((record) => record.manifest)),
		),
	read: (id, relPath) =>
		readRecord(id).pipe(
			Effect.mapError((detail) => loadFailed(id, detail)),
			Effect.flatMap((record) => {
				if (record === undefined) {
					return Effect.fail(loadFailed(id, `plugin "${id}" is not installed`));
				}
				const text = record.files?.[relPath];
				return typeof text === "string"
					? Effect.succeed(text)
					: Effect.fail(
							loadFailed(id, `plugin "${id}" has no file "${relPath}"`),
						);
			}),
		),
};
