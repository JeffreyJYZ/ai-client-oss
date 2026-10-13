import { PluginLoadFailed } from "@lib/plugins/errors";
import type { PluginSource } from "@lib/plugins/loader";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * The desktop `PluginSource` (spec §6/§7): installed plugins live in
 * `<app data>/plugins/<id>/`, so `list` reads each `plugin.json` and `read`
 * reads one file out of a plugin directory. Rust owns the paths (and refuses a
 * file outside the plugin's own directory); this module only marshals, exactly
 * as `lib/db/tauri.ts` does for the db commands.
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

/**
 * One raw manifest's text as a value. `plugin_list` returns each `plugin.json`
 * verbatim, so JSON is parsed here; text that is not JSON is handed on as the
 * raw string — never dropped — for the loader to decode and the UI to show.
 */
const parseManifest = (text: string): Effect.Effect<unknown> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () => "invalid json",
		}),
		() => text,
	);

/** A read failure, or a missing file, as the loader's own error vocabulary. */
const loadFailed = (id: string, detail: string): PluginLoadFailed =>
	new PluginLoadFailed({ detail, pluginId: id });

export const tauri: PluginSource = {
	list: () =>
		call<string[]>("plugin_list").pipe(
			// `list` has no error channel by design (the loader lists what is
			// there); a directory that cannot be read lists nothing, loudly.
			Effect.tapError((detail) =>
				Effect.logWarning(`plugins: cannot list installed plugins: ${detail}`),
			),
			Effect.orElseSucceed(() => [] as readonly string[]),
			Effect.flatMap((raw) => Effect.forEach(raw, parseManifest)),
		),
	read: (id, relPath) =>
		call<string>("plugin_read_file", { id, relPath }).pipe(
			Effect.mapError((detail) => loadFailed(id, detail)),
		),
};
