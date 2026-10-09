import { parseResponsesSend } from "@lib/core/parse";
import { sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ResponsesSend } from "@lib/types/protocols";
import { responsesSendMinTemplate } from "@lib/util/templates";
import type { Effect, Stream } from "effect";

const endpoint = "/v1/responses";

const buildRequest = (send: ResponsesSend, ctx: SendCtx) => {
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
};

export const responses = {
	schema: ResponsesSend,
	endpoint,
	template: responsesSendMinTemplate,
	parse: parseResponsesSend,
	buildRequest,
	send: (ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
		sendStream(
			`${ctx.apiUrl}${endpoint}`,
			ctx.apiKey,
			buildRequest(
				ctx.prev === undefined
					? responsesSendMinTemplate
					: (ctx.prev as ResponsesSend),
				ctx,
			),
		),
} satisfies Provider<ResponsesSend>;
