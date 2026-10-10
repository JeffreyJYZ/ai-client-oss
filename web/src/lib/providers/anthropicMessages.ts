import { parseAnthropicSend } from "@lib/core/parse";
import { requestTools } from "@lib/providers/presets";
import { sendStream } from "@lib/providers/send";
import type {
	Chunk,
	HistoryTurn,
	Provider,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { AnthropicSend } from "@lib/types/protocols";
import type { Effect, Stream } from "effect";

const endpoint = "/messages";

/**
 * The Messages API requires `max_tokens` on every request; the app
 * has no setting for it, so every request uses this cap.
 */
const MAX_TOKENS = 4096;

/** API version sent with every request (see `anthropicHeaders`). */
const API_VERSION = "2023-06-01";

const template: AnthropicSend = {
	model: "",
	max_tokens: MAX_TOKENS,
	messages: [],
	stream: true,
};

/**
 * Split a `data:<media-type>;base64,<data>` URL into the media
 * type and base64 payload an image or document block's `source`
 * carries. `null` when the value is not a base64 data URL.
 */
const decodeDataUrl = (
	dataUrl: string,
): { readonly mediaType: string; readonly data: string } | null => {
	const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
	return match === null ? null : { mediaType: match[1], data: match[2] };
};

/**
 * The Messages API authenticates with `x-api-key` (not a Bearer
 * token) and requires the `anthropic-version` header. Direct
 * browser calls — which this app's webview makes — must opt in
 * with `anthropic-dangerous-direct-browser-access`.
 */
const anthropicHeaders = (
	apiKey: string | undefined,
): Record<string, string> => {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": API_VERSION,
		"anthropic-dangerous-direct-browser-access": "true",
	};
	if (apiKey !== undefined && apiKey !== "") headers["x-api-key"] = apiKey;
	return headers;
};

const buildRequest = (send: AnthropicSend, ctx: SendCtx) => {
	const parts = ctx.parts ?? [];
	// A message without attachments is a plain string; with
	// attachments it is a text block followed by one block per
	// attachment (images and documents share the base64 source
	// shape, differing only in block type).
	const content: string | unknown[] =
		parts.length === 0
			? ctx.msg
			: [
					{ type: "text" as const, text: ctx.msg },
					...parts.flatMap((part) => {
						const decoded = decodeDataUrl(part.dataUrl);
						// An attachment that is not a base64 data URL has
						// nothing to map; the text message still sends.
						if (decoded === null) return [];
						return [
							{
								type: part.kind === "image" ? "image" : "document",
								source: {
									type: "base64" as const,
									media_type: decoded.mediaType,
									data: decoded.data,
								},
							},
						];
					}),
				];
	return {
		...send,
		// Request SSE explicitly: without `stream`, the endpoint
		// returns a single JSON body and a reader expecting `data:`
		// lines yields nothing (silence). Explicit key also overrides
		// any `stream` replayed from a previous turn.
		stream: true,
		model: ctx.model,
		// The system prompt is the top-level `system` parameter —
		// the Messages API has no "system" message role — and
		// `undefined` drops the key when blank (and any prompt
		// replayed from a previous turn's body).
		system: ctx.systemPrompt || undefined,
		// A tool round replays the body its first round sent, which
		// already carries the turn's user message: appending it
		// again would repeat the prompt at the model. The tool loop
		// sets `skipUserMessage` from round 2 on; a fresh turn
		// leaves it unset and the message rides as the last user
		// turn, exactly as before.
		messages: ctx.skipUserMessage
			? [...send.messages]
			: [...send.messages, { role: "user" as const, content }],
		// Explicit key (not a conditional spread): an empty/absent
		// list must overwrite any `tools` replayed from the previous
		// turn's body, or a provider switch would resend the old
		// endpoint's declaration.
		tools: requestTools(ctx, "anthropic"),
	};
};

const appendAssistant = (send: AnthropicSend, text: string) => ({
	...send,
	messages: [...send.messages, { role: "assistant" as const, content: text }],
});

/**
 * Rebuild a Messages body from the conversation's text
 * turns: every turn rides as a `messages` entry with its
 * text as string content — the shape `appendAssistant`
 * writes assistant turns in — so the seed of a stored
 * conversation equals the body its successful turns left
 * behind. Pure.
 */
const seedHistory = (turns: readonly HistoryTurn[]): AnthropicSend => ({
	...template,
	messages: turns.map((turn) => ({
		role: turn.role,
		content: turn.text,
	})),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Append a tool call and its result: a `tool_use` block
 * (keyed by the call's `id`, carrying the parsed arguments
 * as `input`) joins the assistant message that carries the
 * round's text, and the result follows as a user
 * `tool_result` block keyed by `tool_use_id` — merged into
 * a trailing tool-result message when the round already
 * produced one, which is the API's canonical multi-result
 * shape. `failed` sets the block's error flag. Pure.
 */
const appendToolResult = (
	send: AnthropicSend,
	call: ToolCallData,
	result: string,
	failed: boolean,
): unknown => {
	const messages = [...send.messages];
	const use = {
		type: "tool_use",
		id: call.id,
		name: call.name,
		input: isRecord(call.input) ? call.input : {},
	};
	// The round's text was appended first, so the last
	// assistant message carries the round's calls — a later
	// call in the same round joins it there (a body without
	// any assistant message, a hand-edited replay, gets a
	// fresh one). Its text rides as a text block ahead of
	// the call's blocks.
	let index = messages.length - 1;
	while (index >= 0 && messages[index].role !== "assistant") {
		index -= 1;
	}
	if (index >= 0) {
		const assistant = messages[index];
		const content = Array.isArray(assistant.content)
			? assistant.content
			: [{ type: "text", text: assistant.content }];
		messages[index] = {
			...assistant,
			content: [...content, use],
		};
	} else {
		messages.push({ role: "assistant" as const, content: [use] });
	}
	const resultBlock = {
		type: "tool_result",
		tool_use_id: call.id,
		content: result,
		...(failed ? { is_error: true } : {}),
	};
	const tail = messages[messages.length - 1];
	const tailContent = tail?.content;
	// A round's results collect into one user message — the
	// API's canonical multi-result shape — so a trailing
	// tool-result message takes the block.
	if (
		tail?.role === "user" &&
		Array.isArray(tailContent) &&
		tailContent.length > 0 &&
		tailContent[tailContent.length - 1].type === "tool_result"
	) {
		messages[messages.length - 1] = {
			...tail,
			content: [...tailContent, resultBlock],
		};
	} else {
		messages.push({ role: "user" as const, content: [resultBlock] });
	}
	return { ...send, messages };
};

export const anthropic = {
	schema: AnthropicSend,
	endpoint,
	template,
	parse: parseAnthropicSend,
	buildRequest,
	appendAssistant,
	seedHistory,
	appendToolResult,
	headers: anthropicHeaders,
	send: (ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
		sendStream(
			`${ctx.apiUrl}${endpoint}`,
			buildRequest(
				ctx.prev === undefined ? template : (ctx.prev as AnthropicSend),
				ctx,
			),
			anthropicHeaders(ctx.apiKey),
		),
} satisfies Provider<AnthropicSend>;
