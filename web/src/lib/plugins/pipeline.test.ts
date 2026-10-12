import { describe, expect, spyOn, test } from "bun:test";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
} from "@lib/plugins/host";
import {
	type PipelineMeta,
	type PipelineStageKind,
	type PipelineStageMap,
	resolveToolCall,
	run,
} from "@lib/plugins/pipeline";
import { chatcompletions } from "@lib/providers/chatCompletions";
import type {
	Chunk,
	HistoryTurn,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { Effect, Option, Stream } from "effect";

/**
 * A fresh registry set per test: registrations are the subject, so a shared
 * `HostServices` would leak stages between tests (the `tools.test.ts` pattern).
 */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

/** Add one stage straight to the registry, owned by a test plugin id. */
const addStage = <K extends PipelineStageKind>(
	s: HostServicesShape,
	entry: {
		readonly id: string;
		readonly owner: string;
		readonly kind: K;
		readonly priority?: number;
		readonly run: PipelineStageMap[K];
	},
): void => {
	Effect.runSync(s.pipeline.add(entry));
};

/** Run a registry-reading effect against one test's services. */
const runWith = <A, E>(
	effect: Effect.Effect<A, E, HostServices>,
	s: HostServicesShape,
): Promise<A> =>
	Effect.runPromise(Effect.provideService(effect, HostServices, s));

const meta: PipelineMeta = {
	conversationId: "conv-1",
	protocol: "chatcompletions",
};

const text = (t: string): Chunk => ({ kind: "text", text: t });

const call: ToolCallData = {
	id: "call-42",
	key: "0",
	name: "fetch_url",
	args: '{"url":"https://example.com"}',
};

const ctx: SendCtx = {
	msg: "hi",
	prev: undefined,
	apiUrl: "https://example.com",
	model: "the-model",
};

describe("pipeline order", () => {
	test("runs stages by priority then registration order, and ignores other kinds", async () => {
		const s = services();
		const push = (id: string, tag: string, priority?: number): void =>
			addStage(s, {
				id,
				owner: "acme",
				kind: "transformBody",
				...(priority === undefined ? {} : { priority }),
				run: (body) => Effect.succeed(`${body as string}${tag}`),
			});
		push("first", "A");
		push("second", "B", 10);
		push("third", "C");
		// A different kind is never consulted by a `transformBody` run.
		addStage(s, {
			id: "chunk-only",
			owner: "acme",
			kind: "onChunk",
			run: (chunk) => Effect.succeed(Option.some(chunk)),
		});

		const out = await runWith(run("transformBody", "", meta), s);
		expect(out).toBe("BAC");
	});
});

describe("fail-open", () => {
	test("a faulting stage is logged, disabled for the session and skipped; the run continues", async () => {
		const s = services();
		let consulted = 0;
		const log = spyOn(console, "log");
		addStage(s, {
			id: "boom",
			owner: "acme.pipeline",
			kind: "transformBody",
			run: () => {
				consulted += 1;
				throw new Error("stage exploded");
			},
		});
		addStage(s, {
			id: "healthy",
			owner: "acme.pipeline",
			kind: "transformBody",
			run: (body) => Effect.succeed(`${body as string}!`),
		});

		const once = await runWith(run("transformBody", "", meta), s);
		const twice = await runWith(run("transformBody", "", meta), s);
		const calls = log.mock.calls.flat();
		log.mockRestore();

		// The healthy stage still ran, so the turn completed.
		expect(once).toBe("!");
		expect(twice).toBe("!");
		// The faulty stage was consulted once, then disabled for the session.
		expect(consulted).toBe(1);

		const faults = calls.filter((value) => value instanceof PluginFault);
		expect(faults.length).toBeGreaterThanOrEqual(1);
		const fault = faults[0] as PluginFault;
		expect(fault.detail).toContain("boom");
		expect(fault.pluginId).toBe("acme.pipeline");
	});
});

describe("beforeSend", () => {
	test("may rewrite the ctx", async () => {
		const s = services();
		addStage(s, {
			id: "rewrite",
			owner: "acme",
			kind: "beforeSend",
			run: (input) =>
				Effect.succeed(Option.some({ ...input, model: "plugin-model" })),
		});
		const out = await runWith(run("beforeSend", ctx, meta), s);
		expect(Option.isSome(out)).toBe(true);
		expect(Option.getOrThrow(out).model).toBe("plugin-model");
	});

	test("Option.none() aborts the turn", async () => {
		const s = services();
		addStage(s, {
			id: "veto",
			owner: "acme",
			kind: "beforeSend",
			run: () => Effect.succeed(Option.none<SendCtx>()),
		});
		const out = await runWith(run("beforeSend", ctx, meta), s);
		expect(Option.isNone(out)).toBe(true);
	});
});

describe("onChunk", () => {
	test("may drop a chunk and the stream still terminates", async () => {
		const s = services();
		addStage(s, {
			id: "drop-b",
			owner: "acme",
			kind: "onChunk",
			run: (chunk) =>
				Effect.succeed(
					chunk.text === "b" ? Option.none<Chunk>() : Option.some(chunk),
				),
		});
		const collected = await runWith(
			Stream.runCollect(
				Stream.make(text("a"), text("b"), text("c")).pipe(
					Stream.mapEffect((chunk) => run("onChunk", chunk, meta)),
					Stream.filter(Option.isSome),
					Stream.map((option) => option.value),
				),
			),
			s,
		);
		expect(Array.from(collected).map((chunk) => chunk.text)).toEqual([
			"a",
			"c",
		]);
	});
});

describe("afterReply", () => {
	test("rewrites the final reply", async () => {
		const s = services();
		addStage(s, {
			id: "shout",
			owner: "acme",
			kind: "afterReply",
			run: (value) => Effect.succeed(value.toUpperCase()),
		});
		const out = await runWith(run("afterReply", "hi", meta), s);
		expect(out).toBe("HI");
	});
});

describe("onHistory", () => {
	test("sees the seed's turns and its output is what is seeded", async () => {
		const s = services();
		let seen: readonly HistoryTurn[] = [];
		addStage(s, {
			id: "history",
			owner: "acme",
			kind: "onHistory",
			run: (turns) => {
				seen = turns;
				return Effect.succeed([
					...turns,
					{ role: "assistant", text: "injected" } as const,
				]);
			},
		});
		const turns: readonly HistoryTurn[] = [{ role: "user", text: "hello" }];
		const out = await runWith(run("onHistory", turns, meta), s);
		expect(seen).toEqual([{ role: "user", text: "hello" }]);
		const seeded = chatcompletions.seedHistory(out) as {
			messages: Array<{ content: unknown }>;
		};
		expect(seeded.messages.map((message) => message.content)).toEqual([
			"hello",
			"injected",
		]);
	});
});

describe("onToolCall", () => {
	test("a veto still records a result, so the replayed body has no orphaned tool_call", async () => {
		const s = services();
		addStage(s, {
			id: "veto",
			owner: "acme",
			kind: "onToolCall",
			run: () => Effect.succeed({ allow: false }),
		});
		const decision = await runWith(run("onToolCall", call, meta), s);
		expect(decision).toEqual({ allow: false });

		// The loop's own projection of the decision, then the provider's own
		// `appendToolResult` — exactly the pair `state/chat.ts` performs.
		const resolved = resolveToolCall(call, decision);
		expect(resolved.execute).toBe(false);
		expect(resolved.call.id).toBe(call.id);

		const body = chatcompletions.appendAssistant(
			chatcompletions.template,
			"let me check",
		);
		const replayed = chatcompletions.appendToolResult(
			body,
			resolved.call,
			"A plugin declined this tool call.",
		) as {
			messages: Array<{
				role: string;
				tool_calls?: Array<{ id: string }>;
				tool_call_id?: string;
				content: unknown;
			}>;
		};

		const assistant = replayed.messages
			.filter((m) => m.role === "assistant")
			.at(-1);
		expect(assistant?.tool_calls?.map((entry) => entry.id)).toEqual([call.id]);
		const result = replayed.messages.at(-1);
		expect(result?.role).toBe("tool");
		expect(result?.tool_call_id).toBe(call.id);
		expect(result?.content).toBe("A plugin declined this tool call.");
	});

	test("a rewrite keeps the call's id and key so its result correlates", async () => {
		const s = services();
		addStage(s, {
			id: "rewrite",
			owner: "acme",
			kind: "onToolCall",
			run: (original) =>
				Effect.succeed({
					allow: true,
					rewrite: {
						...original,
						id: "forged",
						key: "9",
						name: "web_search",
						args: '{"query":"q"}',
					},
				}),
		});
		const decision = await runWith(run("onToolCall", call, meta), s);
		const resolved = resolveToolCall(call, decision);
		expect(resolved.execute).toBe(true);
		expect(resolved.call.name).toBe("web_search");
		expect(resolved.call.args).toBe('{"query":"q"}');
		// Correlation is the original call's, never the rewrite's forged ids.
		expect(resolved.call.id).toBe(call.id);
		expect(resolved.call.key).toBe(call.key);
	});

	test("a faulting onToolCall stage fails open to allow", async () => {
		const s = services();
		addStage(s, {
			id: "tool-boom",
			owner: "acme",
			kind: "onToolCall",
			run: () => {
				throw new Error("veto exploded");
			},
		});
		const decision = await runWith(run("onToolCall", call, meta), s);
		expect(decision.allow).toBe(true);
	});
});
