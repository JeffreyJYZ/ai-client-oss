import { PluginLoadFailed } from "@lib/plugins/errors";
import { MANIFEST_FILE, type PluginInstaller } from "@lib/plugins/loader";
import { PLUGIN_STORE, pluginDatabase } from "@lib/plugins/source/web";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * The write half of the web `PluginSource` (spec §6/§18): the same IndexedDB
 * store `source/web.ts` reads from, written to instead.
 *
 * **Why this is a second module rather than the read adapter's other method.**
 * `PluginSource` (`loader.ts`) only reads — the loader never writes — so
 * installing is a separate seam, `PluginInstaller`, and it carries a whole
 * plugin as one record. The split is by direction: every reader lives under
 * `source/**` (one per platform, chosen by `source/index.ts`), both writers live
 * here, and the record they agree on is `{ id, manifest, files }`.
 *
 * **The database is not declared here.** Its name, version, object store and
 * upgrade belong to the module that owns the schema, `source/web.ts`; this file
 * imports that connection, so the two halves cannot drift onto two versions of
 * one database — a mismatch which would list every installed plugin as nothing.
 *
 * Nothing here parses or validates: `loader.ts`'s `installPlugin` decodes the
 * manifest before calling, so an invalid plugin never reaches this file.
 */

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
		const database = yield* pluginDatabase.pipe(
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
