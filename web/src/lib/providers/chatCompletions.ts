import { parseChatCompletionsSend } from "@lib/core/parse";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ChatCompletionsSend } from "@lib/types/protocols";
import { Effect, Stream } from "effect";

export const chatcompletions = {
	schema: ChatCompletionsSend,
	endpoint: "/v1/chat/completions",
	template: { model: "" },
	parse: parseChatCompletionsSend,
	buildRequest: (send: ChatCompletionsSend, _ctx: SendCtx) => send,
	send: (_ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string> =>
		Effect.succeed(Stream.empty),
} satisfies Provider<ChatCompletionsSend>;
