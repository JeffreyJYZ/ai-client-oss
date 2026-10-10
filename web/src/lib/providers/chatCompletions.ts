import { parseChatCompletionsSend } from "@lib/core/parse";
import { searchTools } from "@lib/providers/presets";
import { bearerHeaders, sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ChatCompletionsSend } from "@lib/types/protocols";
import type { Effect, Stream } from "effect";

const endpoint = "/chat/completions";
const template = { model: "" };

const buildRequest = (send: ChatCompletionsSend, ctx: SendCtx) => {
	// Drop system messages prepended on an earlier turn: the prompt below is
	// rebuilt from `ctx` each turn so edits replace it instead of stacking.
	const prior = ((send as { messages?: unknown[] }).messages ?? []).filter(
		(message) => (message as { role?: unknown }).role !== "system",
	);
	const system = ctx.systemPrompt
		? [{ role: "system" as const, content: ctx.systemPrompt }]
		: [];
	const parts = ctx.parts ?? [];
	const content =
		parts.length === 0
			? ctx.msg
			: [
					{ type: "text" as const, text: ctx.msg },
					...parts.map((part) =>
						part.kind === "image"
							? {
									type: "image_url" as const,
									image_url: { url: part.dataUrl },
								}
							: {
									type: "file" as const,
									file: { filename: part.name, file_data: part.dataUrl },
								},
					),
				];
	return {
		...send,
		// Request SSE explicitly: without `stream`, the endpoint returns a single
		// JSON body and a reader expecting `data:` lines yields nothing (silence).
		// Explicit key also overrides any `stream` replayed from a previous turn.
		stream: true,
		model: ctx.model,
		messages: [...system, ...prior, { role: "user", content }],
		// Explicit key (not a conditional spread): an empty/absent list must
		// overwrite any `tools` replayed from the previous turn's body, or a
		// provider switch would resend the old endpoint's declaration.
		// Explicit keys: a value replayed from the previous turn's body
		// (`...send`) must be overwritten rather than inherited.
		tools: searchTools(ctx.search, ctx.tools),
		// OpenRouter deprecated the `web` plugin — it searched **once per
		// request**, so a bare "nice" became a query for the city; the
		// `openrouter:web_search` server tool lets the model decide per
		// prompt. Pinned to `undefined` so a replayed body cannot bring the
		// plugin back.
		plugins: undefined,
	};
};

const appendAssistant = (send: ChatCompletionsSend, text: string) => {
	const prior = (send as { messages?: unknown[] }).messages ?? [];
	return {
		...send,
		messages: [...prior, { role: "assistant", content: text }],
	};
};

export const chatcompletions = {
	schema: ChatCompletionsSend,
	endpoint,
	template,
	parse: parseChatCompletionsSend,
	buildRequest,
	appendAssistant,
	headers: bearerHeaders,
	send: (ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
		sendStream(
			`${ctx.apiUrl}${endpoint}`,
			buildRequest(
				ctx.prev === undefined ? template : (ctx.prev as ChatCompletionsSend),
				ctx,
			),
			bearerHeaders(ctx.apiKey),
		),
} satisfies Provider<ChatCompletionsSend>;
