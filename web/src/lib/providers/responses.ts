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
		// Belt-and-braces: emit `stream` explicitly rather than relying on the
		// template's `prev`, so a replayed body can never silently clear it.
		stream: true,
		model: ctx.model,
		// Replace any prompt carried on the previous turn's body rather than let
		// it accumulate; `undefined` drops the key at `JSON.stringify`.
		instructions: ctx.systemPrompt || undefined,
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
		// Explicit key (not a conditional spread): an empty/absent list must
		// overwrite any `tools` replayed from the previous turn's body, or a
		// provider switch would resend the old endpoint's declaration.
		tools: ctx.tools?.length ? ctx.tools : undefined,
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
