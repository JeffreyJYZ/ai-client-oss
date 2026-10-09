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
	buildRequest: (send: ResponsesSend, ctx: SendCtx) => {
		const prior =
			typeof send.input === "string"
				? [
						{
							role: "user" as const,
							content: [{ type: "input_text" as const, text: send.input }],
						},
					]
				: send.input;
		return {
			...send,
			input: [
				...prior,
				{
					role: "user" as const,
					content: [{ type: "input_text" as const, text: ctx.msg }],
				},
			],
		};
	},
	send: (_ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string> =>
		Effect.succeed(Stream.empty),
} satisfies Provider<ResponsesSend>;
