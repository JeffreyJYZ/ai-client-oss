import { parseResponsesSend } from "@lib/core/parse";
import { sendStream } from "@lib/providers/send";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ResponsesSend } from "@lib/types/protocols";
import { responsesSendMinTemplate } from "@lib/util/templates";
import type { Effect, Stream } from "effect";

const endpoint = "/responses";

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
	const attachments = (ctx.parts ?? []).map((part) =>
		part.kind === "image"
			? { type: "input_image" as const, file_url: part.dataUrl }
			: { type: "input_file" as const, file_url: part.dataUrl },
	);
	return {
		...send,
		model: ctx.model,
		input: [
			...prior,
			{
				role: "user" as const,
				content: [
					{ type: "input_text" as const, text: ctx.msg },
					...attachments,
				],
			},
		],
		...(ctx.tools ? { tools: ctx.tools } : {}),
	};
};

const appendAssistant = (send: ResponsesSend, text: string) => {
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
				role: "assistant" as const,
				content: [{ type: "output_text" as const, text }],
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
	appendAssistant,
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
