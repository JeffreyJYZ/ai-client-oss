/**
 * Browser init script that makes the web build take the **desktop** path, so a
 * desktop-only branch can be proven in a browser instead of only reasoned about
 * (see the repo `AGENTS.md`, "Verifying a network feature in a browser").
 *
 *   agent-browser open --init-script scripts/desktop-stub.js http://localhost:5390
 *
 * It must be passed as an **init script**, because `isDesktop` is a module-level
 * read of `__TAURI_INTERNALS__`: a stub installed after load is ignored.
 *
 * The two values below (`0.2.3`, `9.9.9`) are arbitrary on purpose — the point is
 * that the version comparison runs and produces a notice, not what it says.
 *
 * Traps, all expected rather than bugs:
 * - With this stub the Tauri **db** adapter is the selected one and every `db_*`
 *   command rejects, so settings and conversations fall back to in-memory
 *   defaults and a write cannot persist. Prove the *render* and the request that
 *   goes out — never that a setting survived.
 * - Rejecting `plugin:updater|check` makes `findUpdate` fall through to the real
 *   GitHub API, which this script mocks below so the update notice is
 *   deterministic. That is the intended desktop path, not an error.
 *
 * **Never load this from a bun test.** `isDesktop` and the db adapter are chosen
 * at module load, so a stub would leak desktop mode into every later suite in the
 * same process, order-dependently — the same class of hazard as an un-reset
 * `mock.module` (that is why no such test exists).
 */
(() => {
	const realFetch = window.fetch.bind(window);
	// Records the plugin-scoped writes a proof drives through `host.native`, so
	// the transcript shows what actually reached the (stubbed) Rust command.
	window.__t20PluginWrites = [];
	window.__TAURI_INTERNALS__ = {
		invoke: (cmd, args) => {
			if (cmd === "plugin:app|version") return Promise.resolve("0.2.3");
			// The plugin commands Task 20 added. They answer the way Rust would,
			// so the JS layers' adapter selection and `host.native` are provable
			// in a browser; Rust's real path containment is proven by its own
			// unit tests, not here.
			if (cmd === "plugin_list") {
				return Promise.resolve([
					JSON.stringify({
						id: "t20.fixture",
						name: "T20 fixture",
						version: "1.0.0",
						apiVersion: "0.1",
						entry: "main.js",
					}),
				]);
			}
			if (cmd === "plugin_read_file") {
				return Promise.resolve("export default { setup() {} }");
			}
			if (cmd === "plugin_data_dir") {
				return Promise.resolve("/tmp/ai-client-stub/plugin-data/" + args.id);
			}
			if (cmd === "plugin_fs_write") {
				window.__t20PluginWrites.push(args);
				return Promise.resolve(null);
			}
			if (cmd === "plugin_fs_read") return Promise.resolve("stub data");
			if (cmd === "plugin_fs_list") return Promise.resolve(["a.txt"]);
			if (cmd === "plugin_fs_delete") return Promise.resolve(null);
			return Promise.reject(
				new Error("desktop stub: " + cmd + " is not implemented"),
			);
		},
		transformCallback: (cb) => cb,
	};
	window.fetch = (input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url.includes("api.github.com")) {
			return Promise.resolve(
				new Response(JSON.stringify({ tag_name: "desktop-v9.9.9" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}
		return realFetch(input, init);
	};
})();
