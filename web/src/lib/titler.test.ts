import { describe, expect, test } from "bun:test";
import { emptyProviderConfig, type ProviderConfig } from "@lib/db/types";
import type { ProviderEntry } from "@lib/plugins/providers";
import { chatcompletions } from "@lib/providers/chatCompletions";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import {
	cleanTitle,
	resolveTitlerModel,
	TITLER_MAX_TITLE_LENGTH,
	TITLER_PROMPT,
	titleFor,
} from "./titler";

const OPENCODE_URL = "https://opencode.ai/zen/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** A stored provider with only the fields a case cares about set. */
const provider = (
	id: string,
	overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({ ...emptyProviderConfig(id), ...overrides });

describe("resolveTitlerModel", () => {
	test("an opencode provider with a key on desktop resolves to its free lane", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "oc",
			model: "step-5-preview-free",
		});
	});

	test("an opencode provider with an EMPTY key resolves to nothing", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "   " })],
		};
		expect(resolveTitlerModel(settings, true)).toBeUndefined();
	});

	test("the opencode lane is not chosen on web, where its endpoint refuses the preflight", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, false)).toBeUndefined();
	});

	test("no opencode provider falls back to an OpenRouter free model", () => {
		const settings = {
			providers: [provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "or",
			model: "openrouter/free",
		});
	});

	test("an explicit Settings.titler override wins over the rule", () => {
		const settings = {
			providers: [
				provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" }),
				provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" }),
			],
			titler: { providerId: "chosen", model: "chosen-model" },
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "chosen",
			model: "chosen-model",
		});
	});

	test("the free lane is used only while the cached model list still carries it", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-flash", "step-5-preview-free"],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "oc",
			model: "step-5-preview-free",
		});
	});

	test("a free id the cached list no longer carries falls through to OpenRouter", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-flash", "glm-5.3"],
				}),
				provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" }),
			],
		};
		const resolved = resolveTitlerModel(settings, true);
		expect(resolved).toEqual({
			providerId: "or",
			model: "openrouter/free",
		});
		expect(resolved?.model).not.toBe("step-5-preview-free");
	});

	test("a free id the cached list no longer carries never degrades to a paid call", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-pro"],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toBeUndefined();
	});
});

describe("cleanTitle", () => {
	test("strips a Title: prefix, wrapping quotes, markdown and a trailing newline", () => {
		expect(cleanTitle('Title: "**A Small Model Picks a Subject**"\n')).toBe(
			"A Small Model Picks a Subject",
		);
		expect(cleanTitle("### A Heading\n")).toBe("A Heading");
	});

	test("an empty reply cleans to an empty title", () => {
		expect(cleanTitle("   \n")).toBe("");
	});

	test("caps the length", () => {
		expect(cleanTitle("w".repeat(TITLER_MAX_TITLE_LENGTH + 25))).toHaveLength(
			TITLER_MAX_TITLE_LENGTH,
		);
	});

	test("strips decoration before the length cap", () => {
		const wrapped = `**${"w".repeat(TITLER_MAX_TITLE_LENGTH + 25)}**`;
		const cleaned = cleanTitle(wrapped);
		expect(cleaned).toHaveLength(TITLER_MAX_TITLE_LENGTH);
		expect(cleaned).not.toContain("*");
	});
});

describe("TITLER_PROMPT", () => {
	test("asks for a title and nothing else", () => {
		expect(TITLER_PROMPT.toLowerCase()).toContain("title");
		expect(TITLER_PROMPT).not.toBe("");
	});
});

const TITLER_FIRST_MESSAGE = "why is the sky red at sunrise?";
const TITLER_CONVERSATION_ID = "conv-titler-1";
const TITLER_BASE_URL = "https://openrouter.ai/api/v1";
const TITLER_MODEL = "openrouter/free";
/** Obvious placeholder: a real key never reaches this file. */
const TITLER_API_KEY = "fixture-titler-key-not-real";

const textChunk = (text: string): Chunk => ({ kind: "text", text });
const reasoningChunk = (text: string): Chunk => ({ kind: "reasoning", text });

/**
 * The provider **value** `resolveProviderSync` would hand `titleFor`, with only
 * its `send` replaced — everything else stays the real chat/completions
 * protocol, so the body a case builds is the one a real request would carry.
 * Nothing is registered and nothing is mocked: the fake exists only as this
 * local value.
 */
const entryWithSend = (send: Provider<unknown>["send"]): ProviderEntry => ({
	id: "titler-test",
	owner: "titler-test",
	...chatcompletions,
	send,
});

/** A provider whose `send` yields `chunks`, recording the ctx it was given. */
const entryStreaming = (
	chunks: readonly Chunk[],
	captured: SendCtx[] = [],
	bodies: unknown[] = [],
): ProviderEntry =>
	entryWithSend((ctx) =>
		Effect.sync(() => {
			captured.push(ctx);
			bodies.push(
				chatcompletions.buildRequest(
					(ctx.prev ?? chatcompletions.template) as never,
					ctx,
				),
			);
			return Stream.fromIterable(chunks) as Stream.Stream<Chunk, string>;
		}),
	);

const titleEffect = (
	provider: ProviderEntry,
): Effect.Effect<string | undefined, string> =>
	titleFor({
		provider,
		baseUrl: TITLER_BASE_URL,
		apiKey: TITLER_API_KEY,
		model: TITLER_MODEL,
		conversationId: TITLER_CONVERSATION_ID,
		firstMessage: TITLER_FIRST_MESSAGE,
	});

const titleOf = (provider: ProviderEntry): Promise<string | undefined> =>
	// `runPromise` with no service provided is itself the proof of `R = never`.
	Effect.runPromise(titleEffect(provider));

describe("titleFor", () => {
	test("a text chunk becomes the title", async () => {
		expect(await titleOf(entryStreaming([textChunk('"A Red Sunrise"')]))).toBe(
			"A Red Sunrise",
		);
	});

	test("reasoning chunks are ignored", async () => {
		const provider = entryStreaming([
			reasoningChunk("The user is asking about the sky at sunrise. "),
			textChunk("A Red Sunrise"),
		]);
		expect(await titleOf(provider)).toBe("A Red Sunrise");
	});

	test("several text chunks are folded in order", async () => {
		const chunks = [
			textChunk("Red "),
			textChunk("Sunrise"),
			textChunk(" Skies"),
		];
		expect(await titleOf(entryStreaming(chunks))).toBe("Red Sunrise Skies");
	});

	test("a stream that yields no text returns undefined rather than an empty title", async () => {
		expect(await titleOf(entryStreaming([]))).toBeUndefined();
		expect(
			await titleOf(entryStreaming([reasoningChunk("only thinking")])),
		).toBeUndefined();
	});

	test("the request carries no tools and the conversation's own session id", async () => {
		const captured: SendCtx[] = [];
		const bodies: unknown[] = [];
		await titleOf(
			entryStreaming([textChunk("A Red Sunrise")], captured, bodies),
		);

		const ctx = captured.at(0);
		if (ctx === undefined) throw new Error("the provider was never called");
		expect(ctx.conversationId).toBe(TITLER_CONVERSATION_ID);
		expect(ctx.model).toBe(TITLER_MODEL);
		expect(ctx.apiUrl).toBe(TITLER_BASE_URL);
		expect(ctx.tools).toBeUndefined();
		expect(ctx.search).toBeUndefined();
		expect(ctx.fetchTool).toBe(false);
		expect(ctx.msg).toContain(TITLER_PROMPT);
		expect(ctx.msg).toContain(TITLER_FIRST_MESSAGE);

		// The wire body, built by the real protocol from the captured ctx.
		const body = bodies.at(0);
		if (body === undefined) throw new Error("no request body was built");
		expect(JSON.stringify(body)).not.toContain('"tools"');
	});

	test("a failing send surfaces as the typed failure, never a defect or undefined", async () => {
		const failure = "the titler provider refused the request";
		// Both shapes a real send can fail in: the request itself, and a stream
		// that breaks after the title has started arriving.
		const providers = [
			entryWithSend(() => Effect.fail(failure)),
			entryWithSend(() =>
				Effect.succeed(
					Stream.concat(
						Stream.make(textChunk("Partial")),
						Stream.fail(failure),
					) as Stream.Stream<Chunk, string>,
				),
			),
		];

		for (const provider of providers) {
			const exit = await Effect.runPromise(Effect.exit(titleEffect(provider)));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				// `findErrorOption` finds a typed `Fail` and returns `none` for a
				// defect, so this equality is also the proof nothing was thrown.
				expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(failure));
			}
		}
	});
});
