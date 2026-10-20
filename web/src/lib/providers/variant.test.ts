import { describe, expect, test } from "bun:test";
import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";
import type { SendCtx } from "@lib/providers/types";
import {
	anthropicVariant,
	chatCompletionsVariant,
	responsesVariant,
	type VariantParams,
} from "@lib/providers/variant";

/**
 * The wire side of a variant: which fields each protocol sends, and — the
 * claim that matters most — which it does **not** send.
 *
 * A parameter the variant does not set must be *absent* from the body, not
 * present as a guessed default: the endpoint's own default stands. So these
 * tests check the exact key set of each mapping's result, not just that the
 * expected fields are there.
 */

const all: VariantParams = {
	temperature: 0.7,
	topP: 0.9,
	maxTokens: 4096,
	reasoningEffort: "high",
};

/** The keys a mapping emitted, sorted — the exact set, never a superset. */
const keys = (fields: object): readonly string[] => Object.keys(fields).sort();

describe("the chat/completions mapping", () => {
	test("every parameter the variant sets reaches the body, in OpenAI's names", () => {
		const fields = chatCompletionsVariant(all);

		expect(keys(fields)).toEqual([
			"max_tokens",
			"reasoning_effort",
			"temperature",
			"top_p",
		]);
		expect(fields.temperature).toBe(0.7);
		expect(fields.top_p).toBe(0.9);
		expect(fields.max_tokens).toBe(4096);
		expect(fields.reasoning_effort).toBe("high");
	});

	test("an empty variant sends no field at all", () => {
		expect(keys(chatCompletionsVariant({}))).toEqual([]);
		expect(keys(chatCompletionsVariant(undefined))).toEqual([]);
	});

	test("a parameter the variant does not set is absent, not a default", () => {
		const fields = chatCompletionsVariant({ temperature: 0.7 });

		expect(keys(fields)).toEqual(["temperature"]);
		expect(fields.top_p).toBeUndefined();
		expect(fields.max_tokens).toBeUndefined();
		expect(fields.reasoning_effort).toBeUndefined();
	});
});

describe("the responses mapping", () => {
	test("the token cap is `max_output_tokens` and the effort nests under `reasoning`", () => {
		const fields = responsesVariant(all);

		expect(keys(fields)).toEqual([
			"max_output_tokens",
			"reasoning",
			"temperature",
			"top_p",
		]);
		expect(fields.max_output_tokens).toBe(4096);
		expect(fields.reasoning).toEqual({ effort: "high" });
	});

	test("an empty variant sends no field at all", () => {
		expect(keys(responsesVariant({}))).toEqual([]);
		expect(keys(responsesVariant(undefined))).toEqual([]);
	});

	test("a variant without an effort sends no `reasoning` object at all", () => {
		const fields = responsesVariant({ temperature: 0.7 });

		expect(keys(fields)).toEqual(["temperature"]);
		expect(fields.reasoning).toBeUndefined();
	});
});

describe("the anthropic messages mapping", () => {
	test("the three parameters Anthropic has a field for are sent", () => {
		const fields = anthropicVariant(all);

		expect(keys(fields)).toEqual(["max_tokens", "temperature", "top_p"]);
		expect(fields.temperature).toBe(0.7);
		expect(fields.top_p).toBe(0.9);
		expect(fields.max_tokens).toBe(4096);
	});

	test("Anthropic's API has no reasoning-effort field, so an effort is not sent", () => {
		const fields = anthropicVariant({ reasoningEffort: "high" });

		expect(keys(fields)).toEqual([]);
	});

	test("an empty variant sends no field at all", () => {
		expect(keys(anthropicVariant({}))).toEqual([]);
		expect(keys(anthropicVariant(undefined))).toEqual([]);
	});
});

/**
 * The **outgoing body**, not the mapper: a variant's parameters must reach
 * the request each protocol actually sends, in that protocol's own field names.
 */
describe("the outgoing body carries the variant", () => {
	const ctx = (over: Partial<SendCtx> = {}): SendCtx => ({
		msg: "hi",
		prev: undefined,
		apiUrl: "https://example.com/v1",
		model: "the-model",
		...over,
	});

	/** The three shipping protocols, each building its own body. */
	const providers = [
		["chat/completions", chatcompletions],
		["responses", responses],
		["anthropic", anthropic],
	] as const;

	const build = (
		provider: (typeof providers)[number][1],
		c: SendCtx,
	): Record<string, unknown> =>
		(provider.buildRequest as (send: unknown, ctx: SendCtx) => unknown)(
			c.prev ?? provider.template,
			c,
		) as Record<string, unknown>;

	test("chat/completions sends the variant's parameters in OpenAI's names", () => {
		const body = build(chatcompletions, ctx({ variant: all }));

		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBe(0.9);
		expect(body.max_tokens).toBe(4096);
		expect(body.reasoning_effort).toBe("high");
	});

	test("responses sends the token cap as max_output_tokens and the effort nested", () => {
		const body = build(responses, ctx({ variant: all }));

		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBe(0.9);
		expect(body.max_output_tokens).toBe(4096);
		expect(body.reasoning).toEqual({ effort: "high" });
	});

	test("anthropic sends the three fields it has, and keeps its own token cap", () => {
		const body = build(anthropic, ctx({ variant: all }));

		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBe(0.9);
		expect(body.max_tokens).toBe(4096);
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("with no variant the body carries no parameter at all", () => {
		for (const [, provider] of providers) {
			const body = build(provider, ctx());

			expect(body.temperature).toBeUndefined();
			expect(body.top_p).toBeUndefined();
			expect(body.max_output_tokens).toBeUndefined();
			expect(body.reasoning_effort).toBeUndefined();
			expect(body.reasoning).toBeUndefined();
		}
	});

	test("a parameter the variant does not set is absent from the body", () => {
		const body = build(chatcompletions, ctx({ variant: { temperature: 0.7 } }));

		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBeUndefined();
		expect(body.max_tokens).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	test("a value replayed from the previous body is overwritten, not inherited", () => {
		// The body of a turn is replayed as the next turn's base, so a parameter
		// the *previous* variant set must not survive into a body whose variant
		// does not set it.
		const previous = build(chatcompletions, ctx({ variant: all }));
		const body = build(
			chatcompletions,
			ctx({ variant: { temperature: 0.7 }, prev: previous }),
		);

		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBeUndefined();
		expect(body.max_tokens).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});
});
