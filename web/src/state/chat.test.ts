import { describe, expect, test } from "bun:test";
import { emptyProviderConfig, type Settings } from "@lib/db";
import { MEMORY_TAG_OPEN } from "@lib/memory";
import { addMemory, type MemoryEntry } from "@lib/memoryNotes";
import { registerToolBuiltins } from "@lib/plugins/builtin/tools";
import {
	type Host,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import { subscribeHostEvent } from "@lib/plugins/services";
import type { Tool, ToolOutcome } from "@lib/plugins/tools";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { FETCH_URL_NAME } from "@lib/providers/presets";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Effect, Exit, Scope, Stream } from "effect";
import { send } from "@/state/chat";
import { getSettings, setSettings } from "@/state/settings";

/**
 * The announcement claim, on the real request path. T19's `custom-tool`
 * example registers `shout` through `host.tools.register`; this drives the real
 * `send` turn over a provider whose only change is where the body goes. The
 * **outgoing request body** is `chatcompletions.send`'s own first line —
 * `buildRequest(ctx.prev ?? template, ctx)` — so capturing it *is* the wire
 * claim, with no HTTP, no `vite build` and no browser.
 *
 * The tools registry read, the `beforeSend` pipeline and the tool loop all run
 * for real: the tools are added to the runtime's own registry through the same
 * host a plugin gets, exactly as the loader would.
 */

/** The tool T19's example registers, through the same public API. */
const shoutTool: Tool = {
	declaration: {
		name: "shout",
		description: "Uppercase the given text.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "The text to shout." },
			},
			required: ["text"],
		},
	},
	execute: (): Effect.Effect<ToolOutcome> =>
		Effect.succeed({
			result: "HELLO",
			marker: "🔧 shout → HELLO",
			failed: false,
			input: null,
		}),
};

/**
 * Wait for the turn's own completion signal, not a wall-clock deadline.
 *
 * `send` forks the turn on the subsystem runtime, and `finalize` publishes
 * `turn-end` on every exit path (success, failure, abort) once the turn is
 * over. The capturing provider assigns its body **synchronously** inside its
 * `send`, before the stream is consumed, so the body is always set by the time
 * `turn-end` arrives — subscribing before `send` means the event cannot be
 * missed.
 *
 * Nothing here compares wall-clock times, so a machine sleep or a process
 * pause cannot make the wait give up while the turn is still in flight. That
 * is exactly what the replaced deadline did: `Date.now() + 2000` was already
 * in the past when a sleeping machine resumed, so a turn that needs ~150 ms on
 * an idle machine was reported as a 2 s timeout. The wait is bounded by the
 * runtime's own step — the signal a pause cannot defeat — not by elapsed time.
 *
 * It still detects a body that never arrives: `turn-end` fires on every exit
 * path, so the wait always settles, and `sentBody` throws when the body is
 * still unset at that point.
 */
const subscribeTurnEnd = (): {
	readonly done: Promise<void>;
	readonly dispose: () => void;
} => {
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const subscription = subscribeHostEvent("turn-end", () => settle());
	return { done, dispose: () => subscription.dispose() };
};

/** The three helpers a body is inspected with (the `presets.test.ts` shape). */
const toolsOf = (body: unknown): readonly Record<string, unknown>[] =>
	(body as { readonly tools?: readonly Record<string, unknown>[] }).tools ?? [];

const namesOf = (body: unknown): readonly unknown[] =>
	toolsOf(body).map((entry) => {
		const nested = entry.function;
		return typeof nested === "object" && nested !== null
			? (nested as { readonly name?: unknown }).name
			: entry.name;
	});

/** A plugin host on the runtime's own registries, closable to remove its entries. */
const withHost = (
	pluginId: string,
): { readonly host: Host; readonly close: () => void } => {
	const services: HostServicesShape = runtime.runSync(HostServices);
	const scope = Effect.runSync(Scope.make());
	return {
		host: makeHost(services, pluginId, scope),
		close: () => Effect.runSync(Scope.close(scope, Exit.void)),
	};
};

const addProvider = (protocol: string, provider: unknown): Disposable =>
	runtime.runSync(
		Effect.flatMap(HostServices, (services) =>
			services.providers.add({
				id: protocol,
				owner: "t24",
				...(provider as Record<string, unknown>),
			} as unknown as RegistryEntry),
		),
	);

/**
 * The real `chatcompletions` provider with the one line that reaches the wire
 * kept and the HTTP call replaced by an empty stream. `finalize` ends the turn
 * on the first empty round, so one turn, one body.
 */
const captureProvider = (): {
	readonly body: () => unknown;
	readonly provider: unknown;
} => {
	let sent: unknown;
	return {
		body: () => sent,
		provider: {
			...chatcompletions,
			send: (ctx: SendCtx) =>
				Effect.sync(() => {
					sent = chatcompletions.buildRequest(
						(ctx.prev ?? chatcompletions.template) as never,
						ctx,
					);
					return Stream.empty as Stream.Stream<Chunk, string>;
				}),
		},
	};
};

/** Run one real turn against a capturing provider and return the body it sent. */
const sentBody = async (
	protocol: string,
	settings: { readonly fetchToolEnabled?: boolean } = {},
): Promise<unknown> => {
	const capture = captureProvider();
	const providerHandle = addProvider(protocol, capture.provider);
	const before = getSettings();
	setSettings({
		providers: [
			{
				...emptyProviderConfig("t24-provider"),
				protocol,
				baseUrl: "https://example.com/v1",
			},
		],
		activeProviderId: "t24-provider",
		...settings,
	});
	try {
		// Subscribe before starting the turn so its `turn-end` cannot be missed.
		const turn = subscribeTurnEnd();
		try {
			send("hello", []);
			await turn.done;
			const body = capture.body();
			if (body === undefined) throw new Error("timed out waiting for a body");
			return body;
		} finally {
			turn.dispose();
		}
	} finally {
		providerHandle.dispose();
		setSettings({
			providers: before.providers,
			activeProviderId: before.activeProviderId,
			fetchToolEnabled: before.fetchToolEnabled,
		});
	}
};

describe("tools on the outgoing body, through a real turn", () => {
	test("a tool registered through host.tools.register is announced, in the protocol's envelope", async () => {
		const builtin = withHost("app.builtin");
		// The real built-in registrar: `fetch_url` is in the registry too.
		registerToolBuiltins(builtin.host);
		const plugin = withHost("t24.custom-tool");
		plugin.host.tools.register(shoutTool);

		try {
			const body = await sentBody(`t24-wire-${crypto.randomUUID()}`);

			// The built-in is announced once (by policy, not by its registry
			// copy) and the plugin's tool follows it, declared as chat/completions
			// wants a function.
			expect(namesOf(body)).toEqual([FETCH_URL_NAME, "shout"]);
			expect(toolsOf(body).at(-1)).toEqual({
				type: "function",
				function: {
					name: "shout",
					description: shoutTool.declaration.description,
					parameters: shoutTool.declaration.parameters,
				},
			});
		} finally {
			plugin.close();
			builtin.close();
		}
	});

	test("with the fetch tool off, the registry copy does not resurrect it", async () => {
		const builtin = withHost("app.builtin");
		registerToolBuiltins(builtin.host);
		const plugin = withHost("t24.custom-tool");
		plugin.host.tools.register(shoutTool);

		try {
			const body = await sentBody(`t24-wire-${crypto.randomUUID()}`, {
				fetchToolEnabled: false,
			});
			expect(namesOf(body)).toEqual(["shout"]);
		} finally {
			plugin.close();
			builtin.close();
		}
	});
});

/* ------------------------------------------------------- memory area gating */

/**
 * One live note, built through T1's own `addMemory` so the entry has the real
 * store's shape rather than a hand-written literal that could drift from it.
 */
const liveNote = (content: string): MemoryEntry => {
	const result = addMemory(
		[],
		`memory-${crypto.randomUUID()}`,
		content,
		Date.now(),
	);
	if (!result.ok) throw new Error(result.message);
	const note = result.notes[0];
	if (note === undefined) throw new Error("addMemory returned no note");
	return note;
};

/** The system message's text in a chat/completions body, `""` when there is none. */
const systemOf = (body: unknown): string => {
	const messages =
		(
			body as {
				readonly messages?: readonly {
					readonly role?: string;
					readonly content?: unknown;
				}[];
			}
		).messages ?? [];
	const system = messages.find((message) => message.role === "system");
	return typeof system?.content === "string" ? system.content : "";
};

/**
 * Run one real turn over a provider that streams `reply` as a single text
 * chunk, and report both sites Fix 1 touches: the **body** the turn sent (the
 * injected memory block) and the **notes** in the store once the turn ended.
 *
 * `turn-end` is published by `finalize` *after* it has harvested the reply's
 * `<memory>` blocks, so the wait guarantees the store write has happened. The
 * notes are read before the settings reset — the return value, not a later
 * `getSettings()`, is the assertion source.
 */
const runMemoryTurn = async (
	protocol: string,
	reply: string,
	memory: Pick<
		Settings,
		"memoriesEnabled" | "memoryNotes" | "memories" | "builtins"
	>,
): Promise<{
	readonly body: unknown;
	readonly notes: readonly MemoryEntry[];
}> => {
	let sent: unknown;
	const provider = {
		...chatcompletions,
		send: (ctx: SendCtx) =>
			Effect.sync(() => {
				sent = chatcompletions.buildRequest(
					(ctx.prev ?? chatcompletions.template) as never,
					ctx,
				);
				return reply === ""
					? (Stream.empty as Stream.Stream<Chunk, string>)
					: Stream.make({ kind: "text", text: reply } as Chunk);
			}),
	};
	const handle = addProvider(protocol, provider);
	const before = getSettings();
	setSettings({
		providers: [
			{
				...emptyProviderConfig("t5-memory-provider"),
				protocol,
				baseUrl: "https://example.com/v1",
			},
		],
		activeProviderId: "t5-memory-provider",
		...memory,
	});
	try {
		const turn = subscribeTurnEnd();
		try {
			send("hello", []);
			await turn.done;
			if (sent === undefined) throw new Error("timed out waiting for a body");
			return { body: sent, notes: getSettings().memoryNotes };
		} finally {
			turn.dispose();
		}
	} finally {
		handle.dispose();
		setSettings({
			providers: before.providers,
			activeProviderId: before.activeProviderId,
			memoriesEnabled: before.memoriesEnabled,
			memoryNotes: before.memoryNotes,
			memories: before.memories,
			builtins: before.builtins,
		});
	}
};

/**
 * The `app.memory` area is the feature's switch; `memoriesEnabled` is the
 * section's own. Both sites that reach beyond the UI — the system-prompt
 * injection and the note store — must follow the **area**, or turning it off
 * would leave an invisible feature running.
 */
describe("the app.memory area gates the injection and the store", () => {
	const note = "the user prefers terse answers";
	const reply = "ok, noted <memory>the user works in Berlin</memory>";

	test("area off, flag on: no block is injected and the reply's note is not stored", async () => {
		const existing = liveNote(note);
		const { body, notes } = await runMemoryTurn(
			`t5-memory-off-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: true,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: false } },
			},
		);

		expect(systemOf(body)).not.toContain(MEMORY_TAG_OPEN);
		expect(systemOf(body)).not.toContain(note);
		expect(notes).toEqual([existing]);
	});

	test("area on, flag on: the block is injected and the reply's note is stored", async () => {
		const existing = liveNote(note);
		const { body, notes } = await runMemoryTurn(
			`t5-memory-on-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: true,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: true } },
			},
		);

		expect(systemOf(body)).toContain(MEMORY_TAG_OPEN);
		expect(systemOf(body)).toContain(note);
		expect(notes.map((entry) => entry.content)).toEqual([
			note,
			"the user works in Berlin",
		]);
	});

	test("area on, flag off: nothing is injected and nothing is stored", async () => {
		const existing = liveNote(note);
		const { body, notes } = await runMemoryTurn(
			`t5-memory-flag-off-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: false,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: true } },
			},
		);

		expect(systemOf(body)).not.toContain(MEMORY_TAG_OPEN);
		expect(systemOf(body)).not.toContain(note);
		expect(notes).toEqual([existing]);
	});
});
