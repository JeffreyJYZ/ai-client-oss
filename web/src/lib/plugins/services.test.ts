import { describe, expect, spyOn, test } from "bun:test";
import { db } from "@lib/db";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { PLUGIN_DATA_MAX_BYTES } from "@lib/plugins/manifest";
import { registerProvider, requireProvider } from "@lib/plugins/providers";
import {
	type ChatSnapshot,
	type ChatStore,
	makeChatService,
	makeScopedStorage,
	publishChatSnapshot,
	publishHostEvent,
	registerChatStore,
} from "@lib/plugins/services";
import { executeTool, registerTool, type Tool } from "@lib/plugins/tools";
import { testModel } from "@lib/providers/models";
import type { Provider, SendCtx, ToolCallData } from "@lib/providers/types";
import {
	Cause,
	Duration,
	Effect,
	Exit,
	Fiber,
	Option,
	Scope,
	Stream,
} from "effect";
import { z } from "zod";
import { getSettings } from "@/state/settings";

/**
 * The host services (spec §2/§3/§5): storage is per-plugin KV persisting into
 * `Settings.plugins[].data` through the existing `setSettings` patch path, the
 * event bus reaches exactly the subscribers still loaded, `host.db` is the
 * app's own adapter, and the typed registries a plugin reaches (`tools`,
 * `settings`) carry the rules the module seam already enforced.
 */

/** A fresh registry set per test, the `host.test.ts` pattern. */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const host = (id: string, sc: Scope.Closeable = scope()) =>
	makeHost(services(), id, sc);

const emptySnapshot = (): ChatSnapshot => ({
	conversations: [],
	activeId: "conversation-1",
	messages: [],
	status: "idle",
	systemPrompt: "",
	hydrated: true,
});

const call = (name: string, args: string): ToolCallData => ({
	id: "call-1",
	key: "0",
	name,
	args,
});

const tool = (name: string, result: string): Tool => ({
	declaration: { name, description: "d", parameters: { type: "object" } },
	execute: () =>
		Effect.succeed({ result, marker: "m", failed: false, input: null }),
});

describe("scoped storage", () => {
	test("round-trips a value into that plugin's plugins[].data only", () => {
		const a = makeScopedStorage("test.storage.a");
		const b = makeScopedStorage("test.storage.b");

		Effect.runSync(a.set("greeting", "hi"));
		Effect.runSync(b.set("greeting", "yo"));

		expect(Effect.runSync(a.get("greeting"))).toEqual(Option.some("hi"));
		expect(Effect.runSync(b.get("greeting"))).toEqual(Option.some("yo"));
		expect(Effect.runSync(a.keys())).toEqual(["greeting"]);

		// The write landed under the registering plugin's own `data`, and only
		// there — the other plugin's entry is a different object.
		const plugins = getSettings().plugins;
		expect(plugins.find((p) => p.id === "test.storage.a")?.data).toEqual({
			greeting: "hi",
		});
		expect(plugins.find((p) => p.id === "test.storage.b")?.data).toEqual({
			greeting: "yo",
		});

		Effect.runSync(a.delete("greeting"));
		expect(Option.isNone(Effect.runSync(a.get("greeting")))).toBe(true);
		expect(Effect.runSync(a.keys())).toEqual([]);
	});

	test("one plugin cannot read another plugin's keys", () => {
		const a = makeScopedStorage("test.iso.a");
		const b = makeScopedStorage("test.iso.b");

		Effect.runSync(a.set("secret", 1));

		expect(Option.isNone(Effect.runSync(b.get("secret")))).toBe(true);
		expect(Effect.runSync(b.keys())).toEqual([]);
	});

	test("a write reaches the settings adapter as a patch, so backups carry it", () => {
		const persisted = spyOn(db, "setSettings");
		Effect.runSync(makeScopedStorage("test.patch").set("k", 1));
		const patch = persisted.mock.calls.at(-1)?.[0];
		persisted.mockRestore();

		expect(patch).toEqual({ plugins: expect.any(Array) });
	});
});

describe("events (host.on)", () => {
	test("an event reaches its subscribers and stops on unload", () => {
		const sc = scope();
		const h = host("test.events", sc);
		const seen: unknown[] = [];

		h.on("chunk", (payload) => seen.push(payload));
		h.on("turn-end", (payload) => seen.push(["end", payload]));

		publishHostEvent("chunk", { a: 1 });
		publishHostEvent("turn-end", "done");
		expect(seen).toEqual([{ a: 1 }, ["end", "done"]]);

		// Closing the plugin's scope is unload: its handlers stop.
		Effect.runSync(Scope.close(sc, Exit.void));
		publishHostEvent("chunk", { a: 2 });
		expect(seen).toEqual([{ a: 1 }, ["end", "done"]]);
	});

	test("a subscriber that throws is a logged PluginFault and does not stop the others", () => {
		const h = host("test.fault");
		const seen: unknown[] = [];
		const logged = spyOn(console, "log");

		h.on("chunk", () => {
			throw new Error("boom");
		});
		h.on("chunk", (payload) => seen.push(payload));

		expect(() => publishHostEvent("chunk", "x")).not.toThrow();
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(seen).toEqual(["x"]);
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
	});

	test("an unknown event name is refused with a PluginFault", () => {
		const h = host("test.badevent");
		const logged = spyOn(console, "log");
		h.on("not-an-event" as unknown as "chunk", () => {});
		const calls = logged.mock.calls.flat();
		logged.mockRestore();
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
	});
});

describe("host services", () => {
	test("host.db is the app's own adapter instance", () => {
		expect(host("test.db").db).toBe(db);
	});

	test("host.native is none on the web build", () => {
		expect(Option.isNone(host("test.native").native)).toBe(true);
	});

	test("host.chat reads the registered store and drives it", () => {
		const calls: unknown[] = [];
		const store: ChatStore = {
			snapshot: emptySnapshot,
			send: (msg, parts) => calls.push(["send", msg, parts]),
			stop: () => calls.push("stop"),
			newConversation: () => calls.push("new"),
			select: (id) => calls.push(["select", id]),
			rename: (id, title) => calls.push(["rename", id, title]),
			remove: (id) => calls.push(["remove", id]),
		};
		// The app's own chat store registers itself; a fresh service reads it.
		registerChatStore(store);

		const chat = makeChatService();
		expect(chat.snapshot()).toEqual(emptySnapshot());
		Effect.runSync(chat.send("hi", []));
		Effect.runSync(chat.select("conversation-2"));
		Effect.runSync(chat.rename("conversation-2", "Renamed"));
		expect(calls).toEqual([
			["send", "hi", []],
			["select", "conversation-2"],
			["rename", "conversation-2", "Renamed"],
		]);
	});

	test("host.settings.registerSection registers a settings.sections contribution", () => {
		const s = services();
		const h = makeHost(s, "test.sections", scope());
		h.settings.registerSection({
			id: "plugin.section",
			title: "Plugin section",
			component: () => null,
		});

		const entries = Effect.runSync(s.ui.entries());
		const section = entries.find((entry) => entry.id === "plugin.section");
		expect(section).toBeDefined();
		expect(section?.slot).toBe("settings.sections");
	});
});

describe("host.tools is first-wins (obligation 1)", () => {
	test("a plugin registering a built-in name through host.tools is refused", () => {
		const s = services();
		const builtin = makeHost(s, "app.builtin", scope());
		const plugin = makeHost(s, "test.tools", scope());
		const builtinTool = tool("web_search", "builtin");
		const pluginTool = tool("web_search", "plugin");

		builtin.tools.register(builtinTool);
		const logged = spyOn(console, "log");
		plugin.tools.register(pluginTool);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
		const entries = Effect.runSync(s.tools.entries());
		expect(entries.map((entry) => entry.id)).toEqual(["web_search"]);
		// The built-in is what resolves — the intruder left no trace.
		expect((entries[0] as unknown as Tool).execute).toBe(builtinTool.execute);
	});
});

describe("tool executors are validated and isolated (obligation 4)", () => {
	test("registerTool refuses an executor that is not callable", () => {
		const s = services();
		const logged = spyOn(console, "log");
		registerTool(makeHost(s, "test.notfn", scope()), {
			declaration: { name: "x", description: "d", parameters: {} },
			execute: undefined as unknown as Tool["execute"],
		});
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
		expect(Effect.runSync(s.tools.entries())).toEqual([]);
	});

	test("a tool whose executor throws is a logged PluginFault with a failed outcome", async () => {
		const s = services();
		registerTool(makeHost(s, "test.exec", scope()), {
			declaration: { name: "boom", description: "d", parameters: {} },
			execute: () => {
				throw new Error("nope");
			},
		});
		const logged = spyOn(console, "log");
		const outcome = await Effect.runPromise(
			Effect.provideService(
				executeTool("boom", call("boom", "{}")),
				HostServices,
				s,
			),
		);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(outcome.failed).toBe(true);
		expect(typeof outcome.result).toBe("string");
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
	});
});

describe("provider resolution and probe shape (obligations 5, 6)", () => {
	test("requireProvider fails with the one unknown-protocol sentence", async () => {
		const s = services();
		const exit = await Effect.runPromise(
			Effect.provideService(
				Effect.exit(requireProvider("nope")),
				HostServices,
				s,
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Cause.findErrorOption(exit.cause)).toEqual(
				Option.some("unknown protocol: nope"),
			);
		}
	});

	test("testModel probes a plugin protocol with its own request shape", async () => {
		const s = services();
		const seen: unknown[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
			seen.push(JSON.parse(String(init?.body)));
			return Promise.resolve(new Response("", { status: 200 }));
		}) as typeof fetch;
		try {
			const plugin: Provider<{ probe: string }> = {
				schema: z.object({ probe: z.string() }),
				endpoint: "/plugin",
				template: { probe: "" },
				parse: (raw) => Effect.succeed({ probe: String(raw) }),
				buildRequest: (_send, ctx: SendCtx) => ({ probe: ctx.model }),
				appendAssistant: (send) => send,
				seedHistory: () => ({ probe: "" }),
				appendToolResult: (send) => send,
				headers: () => ({}),
				send: () => Effect.succeed(Stream.empty),
			};
			const h = makeHost(s, "test.probe", scope());
			registerProvider(h, "test.probe", plugin, "test.probe");
			await Effect.runPromise(
				Effect.provideService(
					testModel("test.probe", "https://x.test/v1", undefined, "m1"),
					HostServices,
					s,
				),
			);
		} finally {
			globalThis.fetch = original;
		}

		// The probe body is the protocol's own `buildRequest` output, never a
		// hardcoded chat-completions body.
		expect(seen).toEqual([{ probe: "m1" }]);
	});
});

describe("the per-plugin data cap", () => {
	test("a write within the cap lands", () => {
		const storage = makeScopedStorage("test.cap.ok");
		Effect.runSync(storage.set("k", "small"));
		expect(Effect.runSync(storage.get("k"))).toEqual(Option.some("small"));
	});

	test("a write past the cap is refused, nothing stored, a PluginFault logged", () => {
		const storage = makeScopedStorage("test.cap.big");
		Effect.runSync(storage.set("k", "ok"));
		const logged = spyOn(console, "log");
		Effect.runSync(storage.set("big", "x".repeat(PLUGIN_DATA_MAX_BYTES + 1)));
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		// The caller's `set` completes; the oversized value is simply not
		// stored (the cap is a guard, not a schema constraint), and the
		// refusal is a logged PluginFault naming the plugin.
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
		expect(Option.isNone(Effect.runSync(storage.get("big")))).toBe(true);
		expect(Effect.runSync(storage.get("k"))).toEqual(Option.some("ok"));
	});
});

describe("host.chat.changes is bound to the plugin scope", () => {
	test("a subscription stops when the plugin unloads", async () => {
		const sc = scope();
		const h = makeHost(services(), "test.changes", sc);
		const seen: ChatSnapshot[] = [];
		const fiber = Effect.runFork(
			Stream.runForEach(h.chat.changes, (snap) =>
				Effect.sync(() => {
					seen.push(snap);
				}),
			),
		);

		await Effect.runPromise(Effect.sleep(Duration.millis(10)));
		publishChatSnapshot({ ...emptySnapshot(), activeId: "after-open" });
		await Effect.runPromise(Effect.sleep(Duration.millis(10)));
		expect(seen.some((snap) => snap.activeId === "after-open")).toBe(true);

		// Unload is the scope closing; the subscription goes with the plugin.
		Effect.runSync(Scope.close(sc, Exit.void));
		await Effect.runPromise(Effect.sleep(Duration.millis(10)));
		publishChatSnapshot({ ...emptySnapshot(), activeId: "after-close" });
		await Effect.runPromise(Effect.sleep(Duration.millis(10)));

		expect(seen.some((snap) => snap.activeId === "after-close")).toBe(false);
		Effect.runSync(Fiber.interrupt(fiber));
	});
});
