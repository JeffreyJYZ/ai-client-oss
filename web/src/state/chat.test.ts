import { describe, expect, spyOn, test } from "bun:test";
import { emptyProviderConfig, type Settings } from "@lib/db";
import { extractMemories, MEMORY_TAG_OPEN, memoryLogLines } from "@lib/memory";
import { addMemory, type MemoryEntry } from "@lib/memoryNotes";
import {
	MEMORY_TOOL_NAMES,
	registerMemoryTools,
} from "@lib/plugins/builtin/memory";
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
import { getChat, send } from "@/state/chat";
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
 * chunk, and report the three sites the memory feature touches: the **body**
 * the turn sent (the injected memory prompt), the **text** the reply rendered
 * with (the tag strip) and the **notes** in the store once the turn ended.
 *
 * `turn-end` is published by `finalize` *after* it has harvested the reply's
 * `<memory>` blocks and refreshed the store, so the wait guarantees both the
 * store write and the visible message text have happened. The notes and text
 * are read before the settings reset — the return value, not a later
 * `getSettings()`/`getChat()`, is the assertion source.
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
	readonly text: string;
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
			const last = getChat().messages.at(-1);
			return {
				body: sent,
				text: last?.role === "assistant" ? last.text : "",
				notes: getSettings().memoryNotes,
			};
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
 * section's own. Every site that reaches beyond the UI — the system-prompt
 * injection, the note store and the reply-text tag strip — follows the one
 * predicate, or turning memory off would leave an invisible feature running.
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

/* ------------------------------------------------- the tag strip is gated */

/**
 * With memory off the `<memory>` tag is ordinary prose: the strip belongs to
 * the feature, so an off feature interprets nothing — the reply renders
 * **verbatim** rather than having text deleted from it, and no note is stored.
 * Both switches retire the feature, so both are exercised.
 *
 * The reply carries the two shapes the strip acts on — a complete block and an
 * unterminated tag — because a verbatim render proves *neither* was
 * interpreted (the live case deletes the block and truncates at the tag), and
 * a store comparison proves nothing was harvested from either.
 */
describe("the memory tag is prose when the feature is off", () => {
	const note = "the user prefers terse answers";
	const reply =
		"noted <memory>the user works in Berlin</memory> and <memory>half a thought";

	test("area off, flag on: the reply renders verbatim and nothing is stored", async () => {
		const existing = liveNote(note);
		const { text, notes } = await runMemoryTurn(
			`t5-memory-verbatim-area-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: true,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: false } },
			},
		);

		expect(text).toBe(reply);
		expect(notes).toEqual([existing]);
	});

	test("area on, flag off: the reply renders verbatim and nothing is stored", async () => {
		const existing = liveNote(note);
		const { text, notes } = await runMemoryTurn(
			`t5-memory-verbatim-flag-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: false,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: true } },
			},
		);

		expect(text).toBe(reply);
		expect(notes).toEqual([existing]);
	});

	test("live: the block is stripped and stored, the unterminated tag still truncates", async () => {
		const existing = liveNote(note);
		const { text, notes } = await runMemoryTurn(
			`t5-memory-verbatim-on-${crypto.randomUUID()}`,
			reply,
			{
				memoriesEnabled: true,
				memoryNotes: [existing],
				memories: [],
				builtins: { "app.memory": { enabled: true } },
			},
		);

		// Today's behaviour, unchanged: the complete block is removed and its
		// note stored; the unterminated tag drops the rest of the reply.
		expect(text).toBe("noted  and ");
		expect(notes.map((entry) => entry.content)).toEqual([
			note,
			"the user works in Berlin",
		]);
	});
});

/* ------------------------- the five tools, through a real tool turn */

/**
 * One round of a scripted turn: the chunks the provider streams when the tool
 * loop calls it. `textRound` is the model's words; `callRound` is the complete
 * function call the loop acts on (the `tool_call` chunk `chatCompletions`'s
 * parser produces from a `tool_calls[]` event).
 */
const textRound = (...parts: readonly string[]): readonly Chunk[] =>
	parts.map((text): Chunk => ({ kind: "text", text }));

const callRound = (
	name: string,
	args: Record<string, unknown>,
): readonly Chunk[] => [
	{
		kind: "tool_call",
		text: name,
		call: {
			id: `call-${crypto.randomUUID()}`,
			key: "0",
			name,
			args: JSON.stringify(args),
		},
	},
];

/** The `role: "tool"` results a chat/completions body carries, in order. */
const toolResultsOf = (body: unknown): readonly string[] => {
	const messages =
		(
			body as {
				readonly messages?: readonly {
					readonly role?: string;
					readonly content?: unknown;
				}[];
			}
		).messages ?? [];
	return messages
		.filter((message) => message.role === "tool")
		.map((message) =>
			typeof message.content === "string" ? message.content : "",
		);
};

/**
 * Run one real turn against a scripted provider, with the `app.memory` area's
 * five tools registered exactly as the area registers them.
 *
 * `memory` is written **before** the registration, because the registrar reads
 * the setting to decide whether to register at all: that read *is* the wire
 * gate, so a test that set the store afterwards would prove nothing about it.
 *
 * The console capture is the app's own log path, not a convenience: the
 * malformed-block diagnostic is emitted with `Effect.runFork`
 * (`state/chat.ts`'s `commitMemories`), and `Effect.runFork` is
 * `runForkWith(Context.empty())` — it runs on the **default runtime**, with an
 * empty context, so a `Logger.layer` provided around this test's own effects
 * cannot see it (the `Logger.make` idiom of `migrate.test.ts`/`loader.test.ts`
 * only reaches logs emitted inside the provided effect). `console.log` is where
 * that fiber's default logger writes, which is why this is a `console.log`
 * spy — the same capture `builtin/memory.test.ts` uses for a forked
 * `PluginFault`.
 */
const runToolTurn = async (
	protocol: string,
	options: {
		readonly rounds: readonly (readonly Chunk[])[];
		readonly memory: Pick<
			Settings,
			"memoriesEnabled" | "memoryNotes" | "memories" | "builtins"
		>;
		/** Called at the start of round `n`, after round `n-1`'s calls ran. */
		readonly observe?: (round: number) => void;
	},
): Promise<{
	readonly bodies: readonly unknown[];
	readonly text: string;
	readonly markers: readonly string[];
	readonly notes: readonly MemoryEntry[];
	readonly ok: boolean;
	readonly logs: readonly string[];
}> => {
	const bodies: unknown[] = [];
	let round = 0;
	const provider = {
		...chatcompletions,
		send: (ctx: SendCtx) =>
			Effect.sync(() => {
				const index = round;
				round += 1;
				bodies.push(
					chatcompletions.buildRequest(
						(ctx.prev ?? chatcompletions.template) as never,
						ctx,
					),
				);
				options.observe?.(index);
				return Stream.fromIterable(
					options.rounds[index] ?? [],
				) as Stream.Stream<Chunk, string>;
			}),
	};
	const providerHandle = addProvider(protocol, provider);
	const before = getSettings();
	setSettings({
		providers: [
			{
				...emptyProviderConfig("t6-memory-provider"),
				protocol,
				baseUrl: "https://example.com/v1",
			},
		],
		activeProviderId: "t6-memory-provider",
		// Nothing else on the wire: `fetch_url` would otherwise be a declaration
		// a test has to look past to answer "is a memory tool announced?".
		fetchToolEnabled: false,
		...options.memory,
	});
	const memoryHost = withHost("app.memory");
	registerMemoryTools(memoryHost.host);
	// The spy records every line the default logger writes for the turn (it
	// looks the console method up at call time, so the spy sees a fiber's log).
	const log = spyOn(console, "log");
	let ok = false;
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		settle = resolve;
	});
	// Subscribed before `send`, so the turn's own `turn-end` cannot be missed;
	// it carries `ok`, which is the one signal that separates a turn that
	// survived a refusal from one that died (`subscribeTurnEnd` waits on the
	// same event, without the payload).
	const subscription = subscribeHostEvent("turn-end", (payload) => {
		ok = (payload as { readonly ok?: unknown }).ok === true;
		settle();
	});
	try {
		send("hello", []);
		// `turn-end` is published by `finalize` after it harvested the reply and
		// refreshed the store, so this wait guarantees both the store write and
		// the rendered text have happened.
		await done;
		const last = getChat().messages.at(-1);
		return {
			bodies,
			text: last?.role === "assistant" ? last.text : "",
			markers: last?.markers.map((marker) => marker.line) ?? [],
			notes: getSettings().memoryNotes,
			ok,
			logs: log.mock.calls.map((args) =>
				args
					.map((arg) => (typeof arg === "string" ? arg : String(arg)))
					.join(" "),
			),
		};
	} finally {
		subscription.dispose();
		memoryHost.close();
		log.mockRestore();
		setSettings({
			providers: before.providers,
			activeProviderId: before.activeProviderId,
			fetchToolEnabled: before.fetchToolEnabled,
			memoriesEnabled: before.memoriesEnabled,
			memoryNotes: before.memoryNotes,
			memories: before.memories,
			builtins: before.builtins,
		});
		providerHandle.dispose();
	}
};

/**
 * The exact line `commitMemories` logs for a reply that ended with a complete
 * opening tag and no close — derived from the pure module that decides it, so
 * the assertion cannot drift from the production message.
 */
const droppedLine = memoryLogLines(
	extractMemories(`${MEMORY_TAG_OPEN}half a thought`),
)[0] as string;

const liveMemory: Pick<Settings, "memoriesEnabled" | "memories" | "builtins"> =
	{
		memoriesEnabled: true,
		memories: [],
		builtins: { "app.memory": { enabled: true } },
	};

describe("the five memory tools, through a real tool turn", () => {
	test("memory_add stores the note; a second add of the same id is a refusal the model reads, and the turn survives it", async () => {
		const existing = liveNote("the user prefers terse answers");
		// The store the refusal is computed against, read between the rounds:
		// both calls of round 0 have run by then.
		let atRefusal: readonly MemoryEntry[] = [];
		const turn = await runToolTurn(`t6-memory-add-${crypto.randomUUID()}`, {
			rounds: [
				// One round, two calls: the second one reuses the id the first
				// just took.
				[
					...callRound("memory_add", {
						id: "editor-theme",
						content: "the user edits in Zed",
					}),
					...callRound("memory_add", {
						id: "editor-theme",
						content: "a second fact",
					}),
				],
				textRound("noted"),
			],
			memory: { ...liveMemory, memoryNotes: [existing] },
			observe: (round) => {
				if (round === 1) atRefusal = getSettings().memoryNotes;
			},
		});

		// Five tools on the wire, in the protocol's function envelope...
		expect([...namesOf(turn.bodies[0])].sort()).toEqual(
			[...MEMORY_TOOL_NAMES].sort(),
		);
		expect(toolsOf(turn.bodies[0])).toHaveLength(MEMORY_TOOL_NAMES.length);
		// ...and the call executed end to end into the real store.
		expect(turn.notes.map((entry) => entry.id)).toEqual([
			existing.id,
			"editor-theme",
		]);
		expect(turn.notes[1]?.content).toBe("the user edits in Zed");

		// The refusal is T1's own message, and it reached the model as the
		// round's tool result — a result, never a defect that ends the turn.
		const expected = addMemory(atRefusal, "editor-theme", "a second fact", 0);
		expect(expected.ok).toBe(false);
		const refusal = expected.ok ? "" : expected.message;
		expect(toolResultsOf(turn.bodies[1])).toEqual([
			'Memory "editor-theme" saved.',
			refusal,
		]);
		// A refusal is surfaced to the user as a *failed* outcome's marker.
		expect(turn.markers).toContain(`🧠 memory_add failed: ${refusal}`);
		// The turn completed: its own end event says so, and the reply landed.
		expect(turn.ok).toBe(true);
		expect(turn.text).toBe("noted");
		// The store is untouched by the refusal.
		expect(turn.notes).toHaveLength(2);
	});

	test("memory_remove soft-deletes — the entry stays, stamped — and memory_revert puts it back", async () => {
		const rounds = [
			callRound("memory_add", {
				id: "editor-theme",
				content: "the user edits in Zed",
			}),
			callRound("memory_remove", { id: "editor-theme" }),
			callRound("memory_revert", { id: "editor-theme" }),
			textRound("restored"),
		];
		// Read between the removal and the revert: the soft-deleted state.
		let removed: readonly MemoryEntry[] = [];
		const turn = await runToolTurn(`t6-memory-revert-${crypto.randomUUID()}`, {
			rounds,
			memory: { ...liveMemory, memoryNotes: [] },
			observe: (round) => {
				if (round === 2) removed = getSettings().memoryNotes;
			},
		});

		// Soft: the entry is still there, stamped rather than gone.
		expect(removed).toHaveLength(1);
		expect(removed[0]?.id).toBe("editor-theme");
		expect(removed[0]?.deletedAt).toBeTypeOf("number");
		expect(removed[0]?.content).toBe("the user edits in Zed");

		// ...and revert restored it: one entry, same id, same content, live again.
		expect(turn.notes).toHaveLength(1);
		expect(turn.notes[0]?.id).toBe("editor-theme");
		expect(turn.notes[0]?.content).toBe("the user edits in Zed");
		expect(turn.notes[0]?.deletedAt).toBeUndefined();
		expect(turn.markers).toContain('🧠 removed memory "editor-theme"');
		expect(turn.markers).toContain('🧠 reverted memory "editor-theme"');
		expect(turn.ok).toBe(true);
		// The removal's own result taught the model the way back.
		expect(toolResultsOf(turn.bodies[2])).toEqual([
			'Memory "editor-theme" saved.',
			'Memory "editor-theme" removed; memory_revert can restore it.',
		]);
	});

	test("with memory off, no memory tool reaches the wire, a call is refused, and the reply renders verbatim", async () => {
		const existing = liveNote("the user prefers terse answers");
		const reply =
			"noted <memory>the user works in Berlin</memory> and <memory>half a thought";
		const turn = await runToolTurn(`t6-memory-off-${crypto.randomUUID()}`, {
			rounds: [
				callRound("memory_add", { id: "editor-theme", content: "x" }),
				textRound(
					"noted ",
					"<memory>the user works in Berlin</memory>",
					" and <memory>half a thought",
				),
			],
			memory: {
				...liveMemory,
				memoriesEnabled: false,
				memoryNotes: [existing],
			},
		});

		// The wire is the assertion: `memoriesEnabled` off registers none of the
		// five, and the harness declares nothing else, so `tools` is empty
		// (absent, in fact) rather than carrying a tool the model cannot be told
		// not to call.
		expect(toolsOf(turn.bodies[0])).toEqual([]);
		// A call the registry cannot answer is a failed outcome with a sentence.
		expect(toolResultsOf(turn.bodies[1])).toEqual([
			"No tool named memory_add is registered.",
		]);
		// The turn survived it, and the tag is prose: the reply renders
		// **verbatim**, both the complete block and the unterminated tag
		// included, and nothing was harvested from either.
		expect(turn.ok).toBe(true);
		expect(turn.text).toBe(reply);
		expect(turn.notes).toEqual([existing]);
	});

	test("the malformed-block diagnostic fires exactly once for a reply that took several chunks", async () => {
		const turn = await runToolTurn(
			`t6-memory-malformed-${crypto.randomUUID()}`,
			{
				// Three frames, and the tag itself is split across two of them: the
				// render path runs `extractMemories` per frame, so a per-frame log
				// would fire here more than once.
				rounds: [
					textRound("noted <mem", "ory>half a thought", ", so no close tag"),
				],
				memory: { ...liveMemory, memoryNotes: [] },
			},
		);

		const dropped = turn.logs.filter((line) => line.includes(droppedLine));
		// Exactly once, for one reply.
		expect(dropped).toHaveLength(1);
		// The line really describes this reply: the complete opening tag with no
		// close dropped the rest of the text...
		expect(turn.text).toBe("noted ");
		// ...and nothing half-written was stored.
		expect(turn.notes).toEqual([]);
	});

	test("the diagnostic is silent while memory is off — the tag is prose then, so nothing was dropped", async () => {
		const reply = "noted <memory>half a thought";
		const turn = await runToolTurn(
			`t6-memory-malformed-off-${crypto.randomUUID()}`,
			{
				rounds: [textRound(reply)],
				// The area off: the fix round coupled the diagnostic to the
				// feature's own predicate, so it must not claim to have dropped
				// something an off area never interpreted.
				memory: {
					...liveMemory,
					memoryNotes: [],
					builtins: { "app.memory": { enabled: false } },
				},
			},
		);

		expect(turn.logs.filter((line) => line.includes(droppedLine))).toEqual([]);
		expect(turn.text).toBe(reply);
		expect(turn.notes).toEqual([]);
	});
});
