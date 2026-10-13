import type { NativeHandle } from "@lib/plugins/services";
import { invoke } from "@tauri-apps/api/core";
import { Effect, Option } from "effect";

/**
 * The desktop `NativeHandle` (spec §7): the scoped data directory and the file
 * commands the Rust shell exposes, chosen by `isDesktop` in `services.ts`.
 *
 * One handle is bound to one plugin id, so `read`/`write`/`list`/`remove` can
 * only name files inside that plugin's own `plugin-data/<id>/` — and Rust
 * re-checks the resolved path after canonicalizing it, which is the part that
 * is actually enforced. The binding is **not** a security boundary (the
 * `NativeHandle` doc states why); it is the API's honest default.
 */

/** Invoke one command, mapping a rejection to a typed `string` error. */
const call = <A>(
	command: string,
	args?: Record<string, unknown>,
): Effect.Effect<A, string> =>
	Effect.tryPromise({
		try: () => invoke<A>(command, args),
		catch: (cause) => String(cause),
	});

/** The bridge narrowed to one plugin id. */
const handleFor = (pluginId: string): NativeHandle => ({
	forPlugin: (id) => handleFor(id),
	dataDir: call<string>("plugin_data_dir", { id: pluginId }),
	read: (relPath) => call<string>("plugin_fs_read", { id: pluginId, relPath }),
	write: (relPath, contents) =>
		call<void>("plugin_fs_write", { id: pluginId, relPath, contents }),
	list: (relPath) =>
		call<string[]>("plugin_fs_list", { id: pluginId, relPath }),
	remove: (relPath) =>
		call<void>("plugin_fs_delete", { id: pluginId, relPath }),
	http: (request) =>
		call<string>("http_request", {
			method: request.method,
			url: request.url,
			headers: request.headers ?? {},
			body: request.body ?? null,
		}),
});

/**
 * The desktop bridge. Its own id is empty on purpose: the host always calls
 * {@link NativeHandle.forPlugin} first, and an un-narrowed call fails Rust's id
 * check rather than touching any directory.
 */
export const tauriNative: Option.Option<NativeHandle> = Option.some(
	handleFor(""),
);
