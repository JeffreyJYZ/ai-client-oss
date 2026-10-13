import { describe, expect, test } from "bun:test";
import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { FETCH_URL_NAME, requestTools } from "@lib/providers/presets";
import { responses } from "@lib/providers/responses";
import type { SendCtx } from "@lib/providers/types";

/**
 * The tools a request declares. The claim under test is the **outgoing request
 * body**, not a helper's return: a registered tool must reach the body the
 * provider builds, in that protocol's own envelope, once, and the provider's
 * stored toggle must keep governing the search it owns.
 */

/** The tool T19's `custom-tool` example registers, as the registry hands it back. */
const shout = {
	name: "shout",
	description: "Uppercase the given text.",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "The text to shout." } },
		required: ["text"],
	},
};

/** The built-in `fetch_url` declaration, as the registry holds it too. */
const fetchUrlDeclaration = {
	name: FETCH_URL_NAME,
	description: "Fetches a URL and returns the page's readable text.",
	parameters: { type: "object", properties: { url: { type: "string" } } },
};

const ctx = (over: Partial<SendCtx> = {}): SendCtx => ({
	msg: "hi",
	prev: undefined,
	apiUrl: "https://example.com/v1",
	model: "the-model",
	...over,
});

/** The three shipping protocols, each with its own tool envelope. */
const providers = [
	["chat/completions", chatcompletions],
	["responses", responses],
	["anthropic", anthropic],
] as const;

const build = (provider: (typeof providers)[number][1], c: SendCtx): unknown =>
	(provider.buildRequest as (send: unknown, ctx: SendCtx) => unknown)(
		// Build over the replayed body when the context names one, exactly as a
		// provider's own `send` does (`ctx.prev ?? template`); a helper that
		// always started from the template would make the idempotence case
		// rebuild from scratch and never exercise the replayed body at all.
		c.prev ?? provider.template,
		c,
	);

/** Every tool the body declares. */
const toolsOf = (body: unknown): readonly Record<string, unknown>[] =>
	(body as { readonly tools?: readonly Record<string, unknown>[] }).tools ?? [];

/** A declared tool's wire name, whatever envelope carries it. */
const namesOf = (body: unknown): readonly unknown[] =>
	toolsOf(body).map((entry) => {
		const nested = entry.function;
		return typeof nested === "object" && nested !== null
			? (nested as { readonly name?: unknown }).name
			: entry.name;
	});

describe("registered tools reach the outgoing body", () => {
	test("every protocol declares a registered tool, after the built-in fetch tool", () => {
		for (const [label, provider] of providers) {
			const body = build(
				provider,
				ctx({ fetchTool: true, registeredTools: [shout] }),
			);
			expect(namesOf(body), label).toEqual([FETCH_URL_NAME, "shout"]);
		}
	});

	test("the chat/completions envelope carries the tool's own name, description and parameters", () => {
		const body = build(chatcompletions, ctx({ registeredTools: [shout] }));
		expect(toolsOf(body)).toEqual([
			{
				type: "function",
				function: {
					name: shout.name,
					description: shout.description,
					parameters: shout.parameters,
				},
			},
		]);
	});

	test("the responses envelope is the flat function shape", () => {
		const body = build(responses, ctx({ registeredTools: [shout] }));
		expect(toolsOf(body)).toEqual([
			{
				type: "function",
				name: shout.name,
				description: shout.description,
				parameters: shout.parameters,
			},
		]);
	});

	test("the anthropic envelope declares the parameters as input_schema", () => {
		const body = build(anthropic, ctx({ registeredTools: [shout] }));
		expect(toolsOf(body)).toEqual([
			{
				name: shout.name,
				description: shout.description,
				input_schema: shout.parameters,
			},
		]);
	});
});

describe("the policy-owned tools are untouched", () => {
	test("the provider's stored search toggle still gates the search declaration", () => {
		// OpenAI's built-in search declaration carries no `name` — the stored
		// `tools` array is passed through verbatim, which is the policy.
		const stored = [{ type: "web_search_preview", max_num_results: 5 }];
		const on = requestTools(
			ctx({ search: { kind: "openai", maxResults: 5 }, tools: stored }),
			"chatcompletions",
		);
		expect(on).toEqual(stored);

		// Toggle off: `ctx.search` is absent, so nothing is declared.
		expect(requestTools(ctx({ tools: [] }), "chatcompletions")).toBeUndefined();

		// A registered tool joins the policy declaration without disturbing it.
		const both = requestTools(
			ctx({
				search: { kind: "openai", maxResults: 5 },
				tools: stored,
				fetchTool: true,
				registeredTools: [shout],
			}),
			"chatcompletions",
		);
		expect(both).toEqual([
			stored[0],
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: FETCH_URL_NAME }),
			}),
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: shout.name }),
			}),
		]);
	});

	test("a policy-owned name in the registry is declared once, by policy", () => {
		const registered = [fetchUrlDeclaration, shout];

		const on = build(
			chatcompletions,
			ctx({ fetchTool: true, registeredTools: registered }),
		);
		expect(namesOf(on)).toEqual([FETCH_URL_NAME, "shout"]);

		// With the fetch toggle off the registry copy must not resurrect it:
		// `undefined` there means the model cannot call it at all.
		const off = build(chatcompletions, ctx({ registeredTools: registered }));
		expect(namesOf(off)).toEqual(["shout"]);
	});
});

describe("the assembled body is idempotent", () => {
	test("rebuilding over an established body reproduces the same tools, never a doubled list", () => {
		for (const [label, provider] of providers) {
			const c = ctx({ fetchTool: true, registeredTools: [shout] });
			const first = build(provider, c);
			// Exactly what the tool loop does for every round after the first:
			// the body the turn built is replayed as `prev` under
			// `skipUserMessage`, so `buildRequest` re-runs over it.
			const second = build(provider, {
				...c,
				prev: first,
				skipUserMessage: true,
			});
			expect(toolsOf(second), label).toEqual(toolsOf(first));
			expect(namesOf(second), label).toEqual([FETCH_URL_NAME, "shout"]);
		}
	});
});
