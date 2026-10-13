import { PluginLoadFailed } from "@lib/plugins/errors";
import type { PluginSource } from "@lib/plugins/loader";
import { recordLog } from "@lib/plugins/log";
import { Duration, Effect, Exit } from "effect";

/**
 * The web `PluginSource` (spec §6): installed plugins live in an IndexedDB
 * store, `plugins`, whose records are `{ id, manifest, files }` — the raw
 * `plugin.json` value verbatim plus every file of the plugin keyed by its
 * relative path. Reading returns text; the loader decodes and imports it.
 *
 * **This module owns the plugin database**: its name, version, object store and
 * upgrade are declared here and nowhere else, and the write half
 * (`lib/plugins/install.ts`) imports the connection from here rather than
 * opening a second one. One definition is what keeps the two halves off two
 * versions of one database — a mismatch the reader could barely report, since a
 * version it cannot open lists as nothing installed.
 *
 * A separate database from the app's conversations is deliberate: the app's
 * `ai-client` database is versioned by `lib/db/web.ts`, and adding a store to
 * it would couple every plugin install to that schema's version.
 *
 * `list` hands back the manifests **verbatim**, never parsed: an invalid
 * manifest has to reach the UI with its reason instead of vanishing here.
 */

/** The database's persisted identity. Renaming it orphans every install. */
export const DB_NAME = "ai-client-plugins";
/** The schema version this module's `onupgradeneeded` is written for. */
export const DB_VERSION = 1;
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

/**
 * The database's one connection, shared by both halves — the reader here and
 * the writer in `install.ts`. `Effect.cachedWithTTL` memoizes the effect it
 * *returns*, so the outer has to be evaluated exactly once and the result kept:
 * that is what `runSync` does here, on an outer that is a plain `sync` (nothing
 * asynchronous runs at this point). Evaluating the outer per call would hand
 * each caller a fresh memo cell — and so a fresh connection — every time.
 *
 * Only a **successful** open is cached. A store that could not be opened is
 * attempted again on the next operation rather than failing for the rest of the
 * session, which is what keeps an unreadable database retryable.
 */
export const pluginDatabase: Effect.Effect<IDBDatabase, string> =
	Effect.runSync(
		Effect.cachedWithTTL(openDatabase(), (exit) =>
			Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
		),
	);

/** Run one read against the store; every failure maps to a typed `string`. */
const withStore = <A>(
	run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, string> =>
	Effect.gen(function* () {
		const database = yield* pluginDatabase;
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
			// there), so a store that cannot be read lists nothing — but never
			// *silently*: a version mismatch is exactly what fails here, and an
			// empty section is then the only trace a user is left with. The
			// message goes to the plugin log, the panel the Plugins section
			// renders, and to the console for whoever is watching one.
			Effect.tapError((detail) => {
				const message = `plugins: cannot list installed plugins: ${detail}`;
				return Effect.sync(() => {
					recordLog(undefined, "warn", message);
				}).pipe(Effect.andThen(Effect.logWarning(message)));
			}),
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
