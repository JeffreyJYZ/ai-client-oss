import { parseAnthropicSend } from "@lib/core/parse";
import { searchTools } from "@lib/providers/presets";
import { sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
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
		messages: [...send.messages, { role: "user" as const, content }],
		// Explicit key (not a conditional spread): an empty/absent
		// list must overwrite any `tools` replayed from the previous
		// turn's body, or a provider switch would resend the old
		// endpoint's declaration.
		tools: searchTools(ctx.search, ctx.tools),
	};
};

const appendAssistant = (send: AnthropicSend, text: string) => ({
	...send,
	messages: [...send.messages, { role: "assistant" as const, content: text }],
});

export const anthropic = {
	schema: AnthropicSend,
	endpoint,
	template,
	parse: parseAnthropicSend,
	buildRequest,
	appendAssistant,
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
