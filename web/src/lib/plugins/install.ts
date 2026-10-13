import { PluginLoadFailed } from "@lib/plugins/errors";
import { MANIFEST_FILE, type PluginInstaller } from "@lib/plugins/loader";
import { PLUGIN_STORE } from "@lib/plugins/source/web";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * The write half of the web `PluginSource` (spec §6/§18): the same IndexedDB
 * store `source/web.ts` reads from, written to instead.
 *
 * **Why this is a second module rather than two methods on `source/web.ts`.**
 * `src/lib/plugins/source/**` belongs to Task 20 (the Tauri adapter and the
 * platform branch), and a Task 20 implementer is mid-edit in this tree, so the
 * read adapter could not be extended here without two writers on one file. The
 * two halves are therefore split by direction — reading in `source/web.ts`,
 * writing here — and the manager composes them (`runtime.ts`).
 *
 * **The disclosed hazard.** A record is `{ id, manifest, files }`, and both
 * halves must agree on the database name and the object store. The store name is
 * imported (one home, `source/web.ts`); the database name is *not* exported
 * there, so `DB_NAME` is repeated below and the upgrade path recreates the store
 * if this side opens the database first. Move the name into a shared module
 * (Task 20 or the next change to `source/**`) so the two cannot drift.
 *
 * Nothing here parses or validates: `loader.ts`'s `installPlugin` decodes the
 * manifest before calling, so an invalid plugin never reaches this file.
 */

const DB_NAME = "ai-client-plugins";
/** The schema version `source/web.ts` opens with; both must match. */
const DB_VERSION = 1;

/** One installed plugin's record, exactly as `source/web.ts` stores it. */
interface StoredPlugin {
	readonly id: string;
	readonly manifest: unknown;
	readonly files: Record<string, string>;
}

/** A write failure in the loader's own error vocabulary. */
const loadFailed = (id: string, detail: string): PluginLoadFailed =>
	new PluginLoadFailed({ detail, pluginId: id });

/**
 * Open (creating on first run) the plugin database. `Effect.callback` keeps the
 * callback-based Web API inside Effect — the repo pattern for IndexedDB, never a
 * raw `Promise`.
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

/** Memoized connection so every write reuses one database handle. */
const cachedDatabase = Effect.cached(openDatabase());

/**
 * Run one write against the store, resolving when the **transaction** commits
 * rather than when the request succeeds: a request that succeeded inside a
 * transaction that then aborts did not persist, and reporting it as installed
 * would be a lie the next read exposes.
 */
const withWriteStore = (
	id: string,
	run: (store: IDBObjectStore) => void,
): Effect.Effect<void, PluginLoadFailed> =>
	Effect.gen(function* () {
		const open = yield* cachedDatabase;
		const database = yield* open.pipe(
			Effect.mapError((detail) => loadFailed(id, detail)),
		);
		const transaction = yield* Effect.try({
			try: () => {
				const next = database.transaction(PLUGIN_STORE, "readwrite");
				run(next.objectStore(PLUGIN_STORE));
				return next;
			},
			catch: (cause) => loadFailed(id, String(cause)),
		});
		yield* Effect.callback<void, PluginLoadFailed>((resume) => {
			transaction.oncomplete = () => resume(Effect.void);
			transaction.onerror = () =>
				resume(
					Effect.fail(
						loadFailed(
							id,
							`could not store plugin "${id}": ${String(transaction.error ?? "IndexedDB write failed")}`,
						),
					),
				);
			transaction.onabort = () =>
				resume(
					Effect.fail(
						loadFailed(
							id,
							`storing plugin "${id}" was aborted: ${String(transaction.error ?? "IndexedDB transaction aborted")}`,
						),
					),
				);
		});
	});

/** The web installer: installs into, and removes from, the plugin store. */
export const webInstaller: PluginInstaller = {
	write: (id, manifest, files) =>
		withWriteStore(id, (store) =>
			store.put({ id, manifest, files } satisfies StoredPlugin),
		),
	remove: (id) => withWriteStore(id, (store) => store.delete(id)),
};

/* --------------------------------------------------------------- desktop */

/** Invoke one Rust command, mapping a rejection to a typed `string` error. */
const call = <A>(
	command: string,
	args?: Record<string, unknown>,
): Effect.Effect<A, string> =>
	Effect.tryPromise({
		try: () => invoke<A>(command, args),
		catch: (cause) => String(cause),
	});

/**
 * The desktop installer: the two Rust commands Task 20 added for exactly this
 * (`plugin_write_file`, `plugin_remove`), so an install lands in
 * `<app data>/plugins/<id>/` — where the desktop `PluginSource` reads — instead
 * of in a browser store it would never look at.
 *
 * The one ordering decision: files are written in name order with
 * **`plugin.json` last**, because `plugin_list` skips a directory with no
 * readable manifest. A write that dies partway therefore leaves a directory the
 * app does not list, rather than a listed plugin with half its files. The
 * `plugin.json` write itself is what makes the install visible.
 */
export const tauriInstaller: PluginInstaller = {
	write: (id, _manifest, files) => {
		const names = Object.keys(files)
			.filter((name) => name !== MANIFEST_FILE)
			.concat(MANIFEST_FILE);
		return Effect.forEach(
			names,
			(name) =>
				call<void>("plugin_write_file", {
					id,
					relPath: name,
					contents: files[name] ?? "",
				}).pipe(Effect.mapError((detail) => loadFailed(id, detail))),
			{ concurrency: 1 },
		).pipe(Effect.asVoid);
	},
	remove: (id) =>
		call<void>("plugin_remove", { id }).pipe(
			Effect.mapError((detail) => loadFailed(id, detail)),
		),
};
