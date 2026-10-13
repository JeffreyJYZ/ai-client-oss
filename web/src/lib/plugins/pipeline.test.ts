import { describe, expect, spyOn, test } from "bun:test";
import { emptyProviderConfig } from "@lib/db";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
} from "@lib/plugins/host";
import {
	composeTurnBody,
	type PipelineMeta,
	type PipelineStageKind,
	type PipelineStageMap,
	resolveToolCall,
	run,
	stageRunner,
} from "@lib/plugins/pipeline";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import { subscribeHostEvent } from "@lib/plugins/services";
import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";
import type {
	Chunk,
	HistoryTurn,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { Effect, Option, Stream } from "effect";
import { getChat, send } from "@/state/chat";
import { getSettings, setSettings } from "@/state/settings";

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

describe("transformBody and the turn's single body", () => {
	/**
	 * `chat.ts` composes one body with {@link composeTurnBody} and sends it as
	 * `prev` under `skipUserMessage` for every round. These tests drive that
	 * exact pair with each real provider, so the invariant they pin is the one
	 * the turn relies on: the transformed body is what round 1 sends *and* what
	 * is stored, because the provider rebuilds the identical request from it.
	 */
	const providers = [chatcompletions, responses, anthropic];

	test("a transformed body is what round 1 sends and what is stored", async () => {
		for (const provider of providers) {
			const s = services();
			addStage(s, {
				id: `temperature-${provider.endpoint}`,
				owner: "acme",
				kind: "transformBody",
				run: (body) =>
					Effect.succeed({
						...(body as Record<string, unknown>),
						temperature: 0.25,
					}),
			});
			const ctx: SendCtx = {
				msg: "hi",
				prev: undefined,
				apiUrl: "https://example.com",
				model: "the-model",
			};
			const build = provider.buildRequest as (
				send: unknown,
				ctx: SendCtx,
			) => unknown;
			const wire = (await runWith(
				composeTurnBody(build, provider.template, ctx, meta),
				s,
			)) as Record<string, unknown>;

			// What round 1 sends: the provider rebuilds its request from this
			// body, exactly as `SendMsg(protocol, { ...ctx, prev: wire })` does.
			const sent = provider.buildRequest(wire as never, {
				...ctx,
				prev: wire,
				skipUserMessage: true,
			}) as Record<string, unknown>;

			expect(sent.temperature).toBe(0.25);
			// What is stored is the same body: the provider's rebuild is the
			// identity, so sent and stored cannot drift.
			expect(sent).toEqual(wire);
		}
	});

	test("transformBody runs once per turn, so an additive rewrite does not compound", async () => {
		const s = services();
		addStage(s, {
			id: "append-x",
			owner: "acme",
			kind: "transformBody",
			run: (body) => Effect.succeed(`${body as string}x`),
		});
		const ctx: SendCtx = {
			msg: "hi",
			prev: undefined,
			apiUrl: "u",
			model: "m",
		};
		const out = await runWith(
			composeTurnBody((base: unknown) => base, "", ctx, meta),
			s,
		);
		expect(out).toBe("x");
	});
});

describe("async stages", () => {
	test("a stage that awaits a host service runs through `run`, not a throw", async () => {
		const s = services();
		addStage(s, {
			id: "async",
			owner: "acme",
			kind: "transformBody",
			run: (body) =>
				Effect.map(Effect.sleep("1 millis"), () => `${body as string}!`),
		});
		const out = await runWith(run("transformBody", "", meta), s);
		expect(out).toBe("!");
	});

	test("a stage whose async work dies fails open and is disabled", async () => {
		const s = services();
		let consulted = 0;
		addStage(s, {
			id: "reject",
			owner: "acme",
			kind: "transformBody",
			run: () => {
				consulted += 1;
				return Effect.promise(() => Promise.reject(new Error("nope")));
			},
		});
		const first = await runWith(run("transformBody", "kept", meta), s);
		const second = await runWith(run("transformBody", "kept", meta), s);
		expect(first).toBe("kept");
		expect(second).toBe("kept");
		expect(consulted).toBe(1);
	});
});

describe("stageRunner", () => {
	test("resolves the stage list once, so repeated runs skip a late registration", async () => {
		const s = services();
		addStage(s, {
			id: "first",
			owner: "acme",
			kind: "onChunk",
			run: (chunk) =>
				Effect.succeed(Option.some({ ...chunk, text: `${chunk.text}1` })),
		});
		const runner = await runWith(stageRunner("onChunk", meta), s);
		addStage(s, {
			id: "second",
			owner: "acme",
			kind: "onChunk",
			run: (chunk) =>
				Effect.succeed(Option.some({ ...chunk, text: `${chunk.text}2` })),
		});

		const first = await Effect.runPromise(runner.run(text("x")));
		expect(Option.getOrThrow(first).text).toBe("x1");

		const fresh = await runWith(stageRunner("onChunk", meta), s);
		const second = await Effect.runPromise(fresh.run(text("x")));
		expect(Option.getOrThrow(second).text).toBe("x12");
	});

	test("a faulting stage is skipped for the rest of the runner's calls", async () => {
		const s = services();
		let consulted = 0;
		addStage(s, {
			id: "flaky-chunk",
			owner: "acme",
			kind: "onChunk",
			run: (chunk) => {
				consulted += 1;
				if (chunk.text === "b") throw new Error("chunk exploded");
				return Effect.succeed(Option.some(chunk));
			},
		});
		const runner = await runWith(stageRunner("onChunk", meta), s);

		const a = await Effect.runPromise(runner.run(text("a")));
		const b = await Effect.runPromise(runner.run(text("b")));
		const c = await Effect.runPromise(runner.run(text("c")));

		// a consults it, b faults and disables it, c must not consult it again.
		expect(consulted).toBe(2);
		expect(Option.getOrThrow(a).text).toBe("a");
		expect(Option.getOrThrow(b).text).toBe("b");
		expect(Option.getOrThrow(c).text).toBe("c");
	});
});

describe("tool-extended bodies", () => {
	test("a tool-extended body also rebuilds to itself, for every provider", () => {
		for (const provider of [chatcompletions, responses, anthropic]) {
			// The three providers' methods are structurally the same but not a
			// single callable union, so widen once.
			const p = provider as {
				readonly template: unknown;
				readonly buildRequest: (send: unknown, ctx: SendCtx) => unknown;
				readonly appendAssistant: (send: unknown, text: string) => unknown;
				readonly appendToolResult: (
					send: unknown,
					call: ToolCallData,
					result: string,
					failed: boolean,
				) => unknown;
			};
			const ctx: SendCtx = {
				msg: "hi",
				prev: undefined,
				apiUrl: "https://example.com",
				model: "the-model",
			};
			const transformed = {
				...(p.buildRequest(p.template, ctx) as Record<string, unknown>),
				temperature: 0.25,
			};
			const extended = p.appendToolResult(
				p.appendAssistant(transformed, "let me"),
				call,
				"a result",
				true,
			);
			// The turn replays the extended body as `prev`; the provider's
			// rebuild must be the identity or the sent and stored bodies drift.
			const resent = p.buildRequest(extended, {
				...ctx,
				skipUserMessage: true,
			});
			expect(resent).toEqual(extended);
			expect((resent as { temperature?: number }).temperature).toBe(0.25);
		}
	});
});

describe("beforeSend abort", () => {
	const protocol = "t12-abort-protocol";

	/**
	 * The real `chatcompletions` provider with a non-streaming `send`: the
	 * veto fires before any request, but its `appendAssistant` — which reads
	 * `send.messages` — is the strict one the finalizer must satisfy.
	 */
	const abortProvider = {
		...chatcompletions,
		send: () => Effect.succeed(Stream.empty),
	};

	const addToRuntime = (
		add: (
			services: HostServicesShape,
		) => Effect.Effect<Disposable, never, HostServices>,
	): Disposable => runtime.runSync(Effect.flatMap(HostServices, add));

	/**
	 * Wait for the turn's own completion signal, not a wall-clock deadline.
	 *
	 * `finalize` publishes `turn-end` on every exit path — success, failure,
	 * abort — and only after it has written the error row and set `status` to
	 * `idle` (`web/src/state/chat.ts:399-400`), so the snapshot is complete by
	 * the time the event arrives. Subscribing **before** `send` means the event
	 * cannot be missed.
	 *
	 * Nothing here reads a clock, so a machine sleep or a process pause cannot
	 * make the wait give up while the turn is still in flight — exactly what the
	 * replaced `Date.now() + 2000` deadline did. The wait is bounded by the
	 * runtime's own step, the signal a pause cannot defeat.
	 *
	 * It still detects a turn that never ends: the bus event is the only way
	 * the wait settles, so a signal that never fires fails on bun's own test
	 * timeout rather than being papered over.
	 */
	const waitForTurnEnd = (): {
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

	test("a beforeSend veto reaches finalize: an error row lands and the turn ends", async () => {
		const providerHandle = addToRuntime((services) =>
			services.providers.add({
				id: protocol,
				owner: "t12",
				...abortProvider,
			} as unknown as RegistryEntry),
		);
		const stageHandle = addToRuntime((services) =>
			services.pipeline.add({
				id: "veto-abort",
				owner: "t12",
				kind: "beforeSend",
				run: () => Effect.succeed(Option.none<SendCtx>()),
			} as unknown as RegistryEntry),
		);
		const before = getSettings();
		setSettings({
			providers: [{ ...emptyProviderConfig("t12-provider"), protocol }],
			activeProviderId: "t12-provider",
		});
		try {
			// Subscribe before starting the turn so its `turn-end` cannot be missed.
			const turn = waitForTurnEnd();
			try {
				send("please abort", []);
				await turn.done;
				const snapshot = getChat();
				const error = snapshot.messages.at(-1);
				expect(error?.role).toBe("error");
				expect(error?.text).toContain("aborted");
				expect(snapshot.status).toBe("idle");
			} finally {
				turn.dispose();
			}
		} finally {
			stageHandle.dispose();
			providerHandle.dispose();
			setSettings({
				providers: before.providers,
				activeProviderId: before.activeProviderId,
			});
		}
	});
});
