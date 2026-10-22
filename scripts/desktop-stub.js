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
 * Task 25 extended it for the chat transport: `chat_stream` answers with a
 * scripted SSE body (override with `window.__t25Script`, a list of body runs)
 * and `window.__t25ChatStreams` / `window.__t25Cancels` record what the app
 * sent; set `window.__t25Open = true` to leave a request open, so a stopped turn
 * and its `chat_stream_cancel` are observable. `window.__t25Status` overrides
 * the relayed status (default 200), so a probe's non-2xx line is provable
 * through the real transport.
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
	// The plugin-changed event surface (T21). `listen` calls
	// `plugin:event|listen` with the id `transformCallback` returned; this
	// stub's `transformCallback` keeps the callback under that id (as the real
	// Tauri installs it under a `__TAURI_CALLBACK_<id>__` global), so the stored
	// `handler` is an id and `window.__t21Fire` resolves it.
	window.__t21Listeners = {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
	// Every callback `transformCallback` handed out, by id. A `Channel` needs
	// this: its `id` is that return value and it serializes to
	// `__CHANNEL__:<id>` (see `@tauri-apps/api`'s `Channel`).
	const callbacks = new Map();
	let callbackSeq = 0;
	const transformCallback = (callback) => {
		const id = (callbackSeq += 1);
		callbacks.set(id, callback);
		return id;
	};
	// The chat transport (T25). `window.__t25ChatStreams` records every
	// `chat_stream` the app sent, and `window.__t25Cancels` every cancel, so a
	// proof can assert what reached the (stubbed) shell. `window.__t25Script`
	// overrides the scripted SSE body.
	window.__t25ChatStreams = [];
	window.__t25Cancels = [];
	window.__openExternal = [];
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
				return Promise.resolve(
					'export default { setup(host) { host.log.info("t20 fixture loaded"); } }',
				);
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
			if (cmd === "plugin:event|listen") {
				const list = (window.__t21Listeners[args.event] ??= []);
				list.push(args.handler);
				return Promise.resolve(1);
			}
			if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
			// The streaming chat transport (T25). Messages are delivered the way
			// Rust's `Channel` delivers them — each carrying the index it was
			// sent with, then an `end` marker — and the command stays open until
			// the app cancels it, so the cancel path is observable.
			if (cmd === "chat_stream") {
				window.__t25ChatStreams.push({
					requestId: args.requestId,
					url: args.url,
					headers: args.headers,
					body: args.body,
				});
				const channel = args.onEvent;
				const deliver = callbacks.get(channel.id);
				const script = window.__t25Script ?? [
					'data: {"choices":[{"delta":{"content":"stub reply"}}]}\n\n',
					"data: [DONE]\n\n",
				];
				// A request left open (`window.__t25Open`) relays its status and
				// one body run, then stops: the stream is live until the app
				// abandons it, so the cancel path is observable.
				const open = window.__t25Open === true;
				const queue = [
					{ type: "status", status: window.__t25Status ?? 200 },
					...(open ? script.slice(0, 1) : script).map((text) => ({
						type: "chunk",
						text,
					})),
					...(open ? [] : [{ type: "end" }]),
				];
				// Messages are delivered one task at a time, exactly as Rust's
				// channel does, and the command settles **after** them — the
				// reverse order would make the transport's backstop terminal
				// (offered when the command settles) beat the status.
				let index = 0;
				const step = () => {
					const message = queue.shift();
					if (message === undefined || !deliver) return;
					deliver({ index, message });
					index += 1;
					setTimeout(step, 0);
				};
				setTimeout(step, 0);
				if (open) return new Promise(() => {});
				return new Promise((resolve) => {
					setTimeout(resolve, 40);
				});
			}
			if (cmd === "chat_stream_cancel") {
				window.__t25Cancels.push(args.requestId);
				return Promise.resolve(null);
			}
			// The shell's browser opener: recorded, because launching a real
			// browser would leave the proof with nothing to assert.
			if (cmd === "open_external") {
				window.__openExternal.push(args.url);
				return Promise.resolve(null);
			}
			return Promise.reject(
				new Error("desktop stub: " + cmd + " is not implemented"),
			);
		},
		transformCallback,
		unregisterCallback: (id) => callbacks.delete(id),
	};
	// Deliver one event to every stub listener, exactly as an `emit` would. The
	// event id shape matches `@tauri-apps/api/event`'s `Event<T>`.
	window.__t21Fire = (event, payload) => {
		const list = window.__t21Listeners[event] ?? [];
		for (const id of list) {
			const handler = callbacks.get(id);
			if (handler) handler({ event, id: 0, payload });
		}
		return list.length;
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
