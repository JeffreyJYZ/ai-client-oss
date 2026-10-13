import { PluginLoadFailed } from "@lib/plugins/errors";
import type { PluginSource } from "@lib/plugins/loader";
import { recordLog } from "@lib/plugins/log";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * The desktop `PluginSource` (spec §6/§7): installed plugins live in
 * `<app data>/plugins/<id>/`, so `list` reads each `plugin.json` and `read`
 * reads one file out of a plugin directory. Rust owns the paths (and refuses a
 * file outside the plugin's own directory); this module only marshals, exactly
 * as `lib/db/tauri.ts` does for the db commands.
 *
 * The source is built over one command runner rather than closing over the
 * platform's, so a test can hold it without a Tauri host: `@tauri-apps/api/core`
 * is `mock.module`d process-wide by the db suites, and a module mock — unlike a
 * `mock.restore`able spy — cannot be undone, so a plugin-source test cannot
 * reach the real `invoke`. Injecting the runner keeps the test off that mock,
 * the way `PluginInstaller` keeps an install off IndexedDB.
 */

/** One Tauri command invocation — the shape `@tauri-apps/api/core`'s `invoke` has. */
type InvokeCommand = typeof invoke;

/** Invoke one command, mapping a rejection to a typed `string` error. */
const call = <A>(
	run: InvokeCommand,
	command: string,
	args?: Record<string, unknown>,
): Effect.Effect<A, string> =>
	Effect.tryPromise({
		try: () => run<A>(command, args),
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

/** Build the desktop source over one command runner. */
export const makeTauriSource = (run: InvokeCommand): PluginSource => ({
	list: () =>
		call<string[]>(run, "plugin_list").pipe(
			// `list` has no error channel by design (the loader lists what is
			// there), so a directory that cannot be read lists nothing — but
			// never *silently*: `plugin_list` fails for an unreadable directory,
			// a directory entry, or a manifest read, and an empty section is then
			// the only trace a user is left with. The message goes to the plugin
			// log, the panel the Plugins section renders, and to the console for
			// whoever is watching one.
			Effect.tapError((detail) => {
				const message = `plugins: cannot list installed plugins: ${detail}`;
				return Effect.sync(() => {
					recordLog(undefined, "warn", message);
				}).pipe(Effect.andThen(Effect.logWarning(message)));
			}),
			Effect.orElseSucceed(() => [] as readonly string[]),
			Effect.flatMap((raw) => Effect.forEach(raw, parseManifest)),
		),
	read: (id, relPath) =>
		call<string>(run, "plugin_read_file", { id, relPath }).pipe(
			Effect.mapError((detail) => loadFailed(id, detail)),
		),
});

/** The desktop source, over the app's real Tauri IPC. */
export const tauri: PluginSource = makeTauriSource(invoke);
