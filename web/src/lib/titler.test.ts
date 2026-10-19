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

/**
 * A free id taken from the live zen list (measured 2026-10-19): the rule
 * *finds* a free id in the provider's own cached list, it never hardcodes one.
 * Fixtures must carry it in `models` or the case is blind to the rule.
 */
const OPENCODE_FREE_ID = "deepseek-v4.1-flash-free";
/** OpenRouter's free-models router, from that lane's live list. */
const OPENROUTER_FREE_ID = "openrouter/free";
/** A paid id: neither lane may ever fall through to one. */
const PAID_MODEL_ID = "deepseek-v4-pro";

describe("resolveTitlerModel", () => {
	test("an opencode provider with a key on desktop resolves to its free lane", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: [PAID_MODEL_ID, OPENCODE_FREE_ID],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "oc",
			model: OPENCODE_FREE_ID,
		});
	});

	test("an opencode provider with an EMPTY key resolves to nothing", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "   ",
					models: [OPENCODE_FREE_ID],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toBeUndefined();
	});

	test("the opencode lane is not chosen on web, where its endpoint refuses the preflight", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: [OPENCODE_FREE_ID],
				}),
			],
		};
		expect(resolveTitlerModel(settings, false)).toBeUndefined();
	});

	test("no opencode provider falls back to an OpenRouter free model", () => {
		const settings = {
			providers: [
				provider("or", {
					baseUrl: OPENROUTER_URL,
					apiKey: "key",
					models: [OPENROUTER_FREE_ID],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "or",
			model: OPENROUTER_FREE_ID,
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
		// The opencode fixture is test 1's with the free id removed.
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: [PAID_MODEL_ID],
				}),
				provider("or", {
					baseUrl: OPENROUTER_URL,
					apiKey: "key",
					models: [OPENROUTER_FREE_ID],
				}),
			],
		};
		const resolved = resolveTitlerModel(settings, true);
		expect(resolved).toEqual({
			providerId: "or",
			model: OPENROUTER_FREE_ID,
		});
		expect(resolved?.model).not.toBe(OPENCODE_FREE_ID);
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

	test("an empty cached model list carries no free id for either lane", () => {
		// `models` is filled only by Settings' Fetch-models button, so an empty
		// list is the normal state of a fresh provider: it must mean "not
		// carried" and degrade rather than guess an id that may not exist.
		expect(
			resolveTitlerModel(
				{
					providers: [
						provider("oc", {
							baseUrl: OPENCODE_URL,
							apiKey: "key",
							models: [],
						}),
					],
				},
				true,
			),
		).toBeUndefined();
		expect(
			resolveTitlerModel(
				{
					providers: [
						provider("or", {
							baseUrl: OPENROUTER_URL,
							apiKey: "key",
							models: [],
						}),
					],
				},
				true,
			),
		).toBeUndefined();
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

	test("strips a Title: label the model wrapped in markdown or backticks", () => {
		expect(cleanTitle("**Title:** Some Words")).toBe("Some Words");
		expect(cleanTitle("`Title:` Some Words")).toBe("Some Words");
	});

	test("never splits an astral character at the length cap", () => {
		// A code-unit cap cuts this emoji's surrogate pair in half, leaving a
		// lone high surrogate that renders as a replacement character.
		const boundary = `${"w".repeat(TITLER_MAX_TITLE_LENGTH - 1)}😀`;
		const cleaned = cleanTitle(boundary);
		expect(cleaned).toBe(boundary);
		expect([...cleaned]).toHaveLength(TITLER_MAX_TITLE_LENGTH);
		expect([...cleaned].at(-1)).toBe("😀");
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
