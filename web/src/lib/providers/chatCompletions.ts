import { parseChatCompletionsSend } from "@lib/core/parse";
import { sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ChatCompletionsSend } from "@lib/types/protocols";
import type { Effect, Stream } from "effect";

const endpoint = "/v1/chat/completions";
const template = { model: "" };

const buildRequest = (send: ChatCompletionsSend, ctx: SendCtx) => {
	const prior = (send as { messages?: unknown[] }).messages ?? [];
	return {
		...send,
		messages: [...prior, { role: "user", content: ctx.msg }],
	};
};

export const chatcompletions = {
	schema: ChatCompletionsSend,
	endpoint,
	template,
	parse: parseChatCompletionsSend,
	buildRequest,
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
