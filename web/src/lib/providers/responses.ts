import { parseResponsesSend } from "@lib/core/parse";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ResponsesSend } from "@lib/types/protocols";
import { responsesSendMinTemplate } from "@lib/util/templates";
import { Effect, Stream } from "effect";

export const responses = {
	schema: ResponsesSend,
	endpoint: "/v1/responses",
	template: responsesSendMinTemplate,
	parse: parseResponsesSend,
	buildRequest: (send: ResponsesSend, _ctx: SendCtx) => send,
	send: (_ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string> =>
		Effect.succeed(Stream.empty),
} satisfies Provider<ResponsesSend>;
