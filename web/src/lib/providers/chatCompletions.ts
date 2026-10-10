import { parseChatCompletionsSend } from "@lib/core/parse";
import { requestTools } from "@lib/providers/presets";
import { bearerHeaders, sendStream } from "@lib/providers/send";
import type {
	Chunk,
	Provider,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
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
		// A tool round replays the body its first round sent, which
		// already carries the turn's user message: appending it
		// again would repeat the prompt at the model. The tool loop
		// sets `skipUserMessage` from round 2 on; a fresh turn
		// leaves it unset and the message rides as the last user
		// turn, exactly as before.
		messages: ctx.skipUserMessage
			? [...system, ...prior]
			: [...system, ...prior, { role: "user", content }],
		// Explicit key (not a conditional spread): an empty/absent list must
		// overwrite any `tools` replayed from the previous turn's body, or a
		// provider switch would resend the old endpoint's declaration.
		// Explicit keys: a value replayed from the previous turn's body
		// (`...send`) must be overwritten rather than inherited.
		tools: requestTools(ctx, "chatcompletions"),
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

/**
 * Append a tool call and its result: the call joins the assistant
 * message that carries the round's text (`tool_calls`, keyed by the
 * call's `id`), and the result follows as a `role: "tool"` message
 * keyed by `tool_call_id`. Pure.
 */
const appendToolResult = (
	send: ChatCompletionsSend,
	call: ToolCallData,
	result: string,
): unknown => {
	const messages = ((send as { messages?: unknown[] }).messages ??
		[]) as Record<string, unknown>[];
	const next = [...messages];
	const toolCall = {
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: call.args },
	};
	// The round's text was appended first, so the last
	// assistant message carries the round's calls — a later
	// call in the same round joins it there (a body without
	// any assistant message, a hand-edited replay, gets a
	// fresh one).
	let index = next.length - 1;
	while (index >= 0 && next[index].role !== "assistant") {
		index -= 1;
	}
	if (index >= 0) {
		const assistant = next[index];
		const calls = Array.isArray(assistant.tool_calls)
			? assistant.tool_calls
			: [];
		next[index] = {
			...assistant,
			tool_calls: [...calls, toolCall],
		};
	} else {
		next.push({
			role: "assistant",
			content: "",
			tool_calls: [toolCall],
		});
	}
	next.push({ role: "tool", tool_call_id: call.id, content: result });
	return { ...send, messages: next };
};

export const chatcompletions = {
	schema: ChatCompletionsSend,
	endpoint,
	template,
	parse: parseChatCompletionsSend,
	buildRequest,
	appendAssistant,
	appendToolResult,
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
