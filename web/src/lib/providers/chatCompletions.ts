import { parseChatCompletionsSend } from "@lib/core/parse";
import { sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ChatCompletionsSend } from "@lib/types/protocols";
import type { Effect, Stream } from "effect";

const endpoint = "/v1/chat/completions";
const template = { model: "" };

const buildRequest = (send: ChatCompletionsSend, ctx: SendCtx) => {
	const prior = (send as { messages?: unknown[] }).messages ?? [];
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
		model: ctx.model,
		messages: [...prior, { role: "user", content }],
		...(ctx.tools ? { tools: ctx.tools } : {}),
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
	send: (ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
		sendStream(
			`${ctx.apiUrl}${endpoint}`,
			ctx.apiKey,
			buildRequest(
				ctx.prev === undefined ? template : (ctx.prev as ChatCompletionsSend),
				ctx,
			),
		),
} satisfies Provider<ChatCompletionsSend>;
