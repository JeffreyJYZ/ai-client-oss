import { describe, expect, test } from "bun:test";
import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import {
	FETCH_URL_NAME,
	mergeProviderPresets,
	PROVIDER_PRESETS,
	requestTools,
	searchKindFor,
} from "@lib/providers/presets";
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

/**
 * `https://opencode.ai/docs/go/`, "Endpoints": every Go model is served under
 * this one prefix — the API family is the method path (`/chat/completions`,
 * `/responses`, `/messages`), never a second base — and the page's own model
 * list is `curl https://opencode.ai/inference/go/v1/models`. So the base URL is
 * a single documented string, and "Fetch models" (which appends `/models`) is
 * correct against it.
 */
const GO_BASE_URL = "https://opencode.ai/inference/go/v1";

describe("the OpenCode Go preset points at the documented Go endpoint", () => {
	const preset = PROVIDER_PRESETS.find((entry) => entry.id === "opencode-go");

	test("its base URL is the one the Go docs give", () => {
		expect(preset?.baseUrl).toBe(GO_BASE_URL);
	});

	test("it is not the undocumented /zen alias", () => {
		// The preset shipped as `https://opencode.ai/zen/go/v1`, which the Go
		// docs never mention (the Go page carries zero `zen/` paths), so a
		// drift back to that shape fails here rather than at a user's button.
		expect(preset?.baseUrl).not.toContain("/zen/");
	});

	test("the models path the app builds from it is the documented one", () => {
		expect(`${preset?.baseUrl}/models`).toBe(`${GO_BASE_URL}/models`);
	});

	test("its default protocol is the open models' family", () => {
		// Open models (GLM, Kimi, DeepSeek, MiMo, LongCat) are Chat Completions;
		// the page's GPT/Grok entries are Responses and its Claude/Qwen ones
		// Messages, which the Protocol dropdown selects over this same base.
		expect(preset?.protocol).toBe("chatcompletions");
	});
});

describe("the Volcengine ARK preset points at the documented endpoint", () => {
	const preset = PROVIDER_PRESETS.find((entry) => entry.id === "ark");

	test("its base URL carries the version, as every other preset does", () => {
		expect(preset?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
	});

	test("it is a Chat Completions endpoint", () => {
		expect(preset?.protocol).toBe("chatcompletions");
	});

	test("it declares no server-side search, so TinyFish fills the gap", () => {
		// ARK's chat API has no web-search tool of its own (豆包搜索 is a
		// separate product), so the per-provider toggle must fall to the
		// client-side search rather than claim a mechanism the endpoint lacks.
		expect(preset?.tools).toEqual([]);
		expect(searchKindFor(preset?.baseUrl ?? "")).toBeNull();
	});
});

describe("mergeProviderPresets", () => {
	const live = [
		{
			id: "plugin-preset",
			label: "Plugin Preset",
			baseUrl: "https://plugin.example/v1",
			protocol: "chatcompletions",
			tools: [],
		},
		{
			id: "openai-chat",
			label: "Shadow",
			baseUrl: "https://shadow.example/v1",
			protocol: "chatcompletions",
			tools: [],
		},
	];

	test("built-ins come first", () => {
		const merged = mergeProviderPresets(PROVIDER_PRESETS, live);
		expect(merged[0]?.id).toBe(PROVIDER_PRESETS[0]?.id);
	});

	test("appends live entries that do not collide", () => {
		const merged = mergeProviderPresets(PROVIDER_PRESETS, live);
		expect(merged.map((p) => p.id)).toContain("plugin-preset");
	});

	test("a built-in wins a collision", () => {
		const merged = mergeProviderPresets(PROVIDER_PRESETS, live);
		const found = merged.find((p) => p.id === "openai-chat");
		expect(found?.baseUrl).toBe(
			PROVIDER_PRESETS.find((p) => p.id === "openai-chat")?.baseUrl,
		);
	});

	test("dedupes by id", () => {
		const merged = mergeProviderPresets(PROVIDER_PRESETS, live);
		const count = merged.filter((p) => p.id === "plugin-preset").length;
		expect(count).toBe(1);
	});
});
