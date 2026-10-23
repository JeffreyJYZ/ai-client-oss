import { afterEach, describe, expect, test } from "bun:test";
import { PREFLIGHT_REFUSAL } from "@lib/providers/presets";
import { chatHeaders, sendStream } from "@lib/providers/send";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { SITE_URL } from "@/constants/links";

/**
 * The outgoing request's headers and the parsing of what comes back. The claim
 * under test is the **request the app makes**, not a helper's return value
 * alone: the session header an OpenCode endpoint requires must be on the wire,
 * and nothing about the web path's body handling may have moved.
 */

/** The URL a user points an OpenCode Go provider at (per-family base). */
const OPENCODE_URL = "https://opencode.ai/inference/openai/v1/chat/completions";

interface FetchCall {
	readonly url: string;
	readonly init: RequestInit;
}

const realFetch = globalThis.fetch;
const calls: FetchCall[] = [];

/** Replace the global `fetch` for one test, recording how it was called. */
const stubFetch = (respond: () => Response | Promise<Response>): void => {
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return Promise.resolve(respond());
	}) as unknown as typeof fetch;
};

const headersOf = (call: FetchCall): Record<string, string> =>
	call.init.headers as Record<string, string>;

/** The `string` a failed effect carries, or `""` when it succeeded. */
const failureOf = async (
	effect: Effect.Effect<unknown, string>,
): Promise<string> => {
	const exit = await Effect.runPromise(Effect.exit(effect));
	return Exit.isFailure(exit)
		? Option.getOrElse(Cause.findErrorOption(exit.cause), () => "")
		: "";
};

afterEach(() => {
	globalThis.fetch = realFetch;
	calls.length = 0;
});

describe("the OpenCode session header", () => {
	test("rides an opencode.ai request with that conversation's own stable id", () => {
		const conversationId = "conv-abc-1";
		const sent = chatHeaders(
			OPENCODE_URL,
			{ "content-type": "application/json" },
			conversationId,
		);
		expect(sent).toEqual({
			"content-type": "application/json",
			"x-opencode-session": conversationId,
		});
		// Stable: the same conversation sends the same id on every request, so
		// the endpoint can route and cache the conversation as one.
		expect(chatHeaders(OPENCODE_URL, {}, conversationId)).toEqual({
			"x-opencode-session": conversationId,
		});
	});

	test("is never sent to another host", () => {
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"https://api.anthropic.com/v1",
			"https://api.commandcode.ai/provider/v1",
			"http://localhost:11434/v1",
		]) {
			const sent = chatHeaders(
				`${baseUrl}/chat/completions`,
				{ "content-type": "application/json" },
				"conv-abc-1",
			);
			expect(Object.keys(sent), baseUrl).toEqual(["content-type"]);
		}
	});

	test("reaches the wire on a send, through the assembled headers", async () => {
		stubFetch(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const stream = await Effect.runPromise(
			sendStream(
				OPENCODE_URL,
				{ model: "deepseek-v4.1-flash" },
				{ "content-type": "application/json" },
				"conv-abc-1",
			),
		);
		const chunks = await Effect.runPromise(Stream.runCollect(stream));

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(OPENCODE_URL);
		expect(headersOf(calls[0])["x-opencode-session"]).toBe("conv-abc-1");
		expect([...chunks]).toEqual([{ kind: "text", text: "hi" }]);
	});

	test("is absent for a request that belongs to no conversation", () => {
		// The Settings connection probe builds its own request and has no
		// conversation; nothing may be invented for it.
		expect(chatHeaders(OPENCODE_URL, {}, undefined)).toEqual({});
	});
});

describe("OpenRouter app attribution", () => {
	const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

	test("names the app on an openrouter.ai request, with or without a conversation", () => {
		const expected = {
			"HTTP-Referer": SITE_URL,
			"X-OpenRouter-Title": "Open Source AI Client",
			"X-OpenRouter-Categories": "general-chat,programming-app",
		};
		expect(chatHeaders(OPENROUTER_URL, {}, undefined)).toEqual(expected);
		expect(chatHeaders(OPENROUTER_URL, {}, "conv-abc-1")).toEqual(expected);
	});

	test("is never sent to another host", () => {
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"https://api.anthropic.com/v1",
			"https://opencode.ai/inference/go/v1",
			"http://localhost:11434/v1",
		]) {
			const sent = chatHeaders(`${baseUrl}/chat/completions`, {}, undefined);
			expect(Object.keys(sent), baseUrl).toEqual([]);
		}
	});

	test("is dropped whole when the provider's toggle is off", () => {
		// Off is every attribution header gone and nothing else changed: the
		// provider's own headers and any session header still go.
		expect(chatHeaders(OPENROUTER_URL, {}, undefined, false)).toEqual({});
		expect(chatHeaders(OPENROUTER_URL, {}, "conv-abc-1", false)).toEqual({});
		expect(
			chatHeaders(OPENROUTER_URL, { "x-api-key": "k" }, undefined, false),
		).toEqual({ "x-api-key": "k" });
	});

	test("is off on the wire too, not just in the assembled headers", async () => {
		stubFetch(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const stream = await Effect.runPromise(
			sendStream(
				OPENROUTER_URL,
				{ model: "openai/gpt-5.2" },
				{},
				undefined,
				false,
			),
		);
		await Effect.runPromise(Stream.runCollect(stream));

		const sent = headersOf(calls[0]);
		expect(sent["HTTP-Referer"]).toBeUndefined();
		expect(sent["X-OpenRouter-Title"]).toBeUndefined();
	});

	test("reaches the wire on a send, through the assembled headers", async () => {
		stubFetch(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);

		const stream = await Effect.runPromise(
			sendStream(OPENROUTER_URL, { model: "openai/gpt-5.2" }, {}, "conv-abc-1"),
		);
		await Effect.runPromise(Stream.runCollect(stream));

		const sent = headersOf(calls[0]);
		expect(sent["HTTP-Referer"]).toBe(SITE_URL);
		expect(sent["X-OpenRouter-Title"]).toBe("Open Source AI Client");
	});
});

describe("the web request path", () => {
	test("a 2xx body is parsed line by line, as it always was", async () => {
		stubFetch(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"reasoning_content":"why"}}]}\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
					{ status: 200 },
				),
		);
		const stream = await Effect.runPromise(
			sendStream("https://openrouter.ai/api/v1/chat/completions", {}, {}),
		);
		const chunks = await Effect.runPromise(Stream.runCollect(stream));
		expect([...chunks]).toEqual([
			{ kind: "reasoning", text: "why" },
			{ kind: "text", text: "hi" },
		]);
	});

	test("a non-2xx fails with the status and the body's own text", async () => {
		stubFetch(() => new Response('{"error":"no such model"}', { status: 404 }));
		const failure = await failureOf(
			sendStream("https://openrouter.ai/api/v1/chat/completions", {}, {}),
		);
		expect(failure).toBe('HTTP 404: {"error":"no such model"}');
	});

	test("a refused cross-origin request to an OpenCode host says what happened", async () => {
		// What a webview reports for a host that refuses the CORS preflight:
		// WebKit's own string, with nothing a user can act on.
		globalThis.fetch = (() =>
			Promise.reject(new TypeError("Load failed:"))) as unknown as typeof fetch;

		const refusal = await failureOf(sendStream(OPENCODE_URL, {}, {}));
		expect(refusal).toBe(PREFLIGHT_REFUSAL);

		// Any other host keeps the description it always had.
		const other = await failureOf(
			sendStream("https://openrouter.ai/api/v1/chat/completions", {}, {}),
		);
		expect(other).toContain("Load failed");
	});
});
