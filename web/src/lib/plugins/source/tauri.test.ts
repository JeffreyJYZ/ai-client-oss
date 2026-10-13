import { afterEach, describe, expect, test } from "bun:test";
import { clearLog, getLogSnapshot } from "@lib/plugins/log";
import { makeTauriSource } from "@lib/plugins/source/tauri";
import { Effect } from "effect";

/**
 * The desktop source, built over a command runner whose `plugin_list` fails the
 * way the real one can (`lib.rs`'s `plugin_list` reads the plugins directory,
 * each directory entry, and each manifest, and any of those can fail for a
 * reason other than a missing file). The read half has no error channel —
 * `PluginSource.list` lists what is there — so the failure must reach the
 * section's log panel instead of vanishing into "Nothing installed."
 *
 * The runner is injected rather than the web source's faked global: the db
 * suites `mock.module` `@tauri-apps/api/core` process-wide, a mock that cannot
 * be undone, so `window.__TAURI_INTERNALS__` never gets a chance to matter here.
 */

/** A runner where every command rejects — `plugin_list` among them. */
const failingInvoke: typeof import("@tauri-apps/api/core").invoke = () =>
	Promise.reject(new Error("failed to read the plugins directory"));

afterEach(() => {
	clearLog();
});

describe("a plugin directory the desktop cannot read", () => {
	/**
	 * `plugin_list` rejects, and the reader swallows it to an empty list. The
	 * list stays empty — its contract has no error channel — but the reason must
	 * not be invisible, or an installed plugin "disappears" with nothing a user
	 * can report.
	 */
	test("is reported where the user can see it, not silently listed as nothing", async () => {
		clearLog();

		const listed = await Effect.runPromise(
			makeTauriSource(failingInvoke).list(),
		);
		const logged = getLogSnapshot()
			.map((line) => line.message)
			.join("\n");

		// The read half lists nothing rather than raising …
		expect(listed).toEqual([]);
		// … but the failure reaches the log panel the Plugins section renders,
		// naming the cause a user can quote.
		expect(logged).toContain("cannot list installed plugins");
		expect(logged).toContain("failed to read the plugins directory");
	});
});
