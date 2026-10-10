import { parseResponsesSend } from "@lib/core/parse";
import { requestTools } from "@lib/providers/presets";
import { bearerHeaders, sendStream } from "@lib/providers/send";
import type {
	Chunk,
	HistoryTurn,
	Provider,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
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
		// A tool round replays the body its first round sent, which
		// already carries the turn's user message: appending it
		// again would repeat the prompt at the model. The tool loop
		// sets `skipUserMessage` from round 2 on; a fresh turn
		// leaves it unset and the message rides as the last user
		// turn, exactly as before.
		input: ctx.skipUserMessage
			? [...prior]
			: [
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
		tools: requestTools(ctx, "responses"),
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

/**
 * Rebuild a Responses body from the conversation's text
 * turns: every turn rides as an `input` item — user turns
 * as `input_text`, assistant turns as `output_text`, the
 * shapes `buildRequest` and `appendAssistant` write — so
 * the seed of a stored conversation equals the body its
 * successful turns left behind. Pure.
 */
const seedHistory = (turns: readonly HistoryTurn[]): ResponsesSend => ({
	...responsesSendMinTemplate,
	input: turns.map((turn) => ({
		role: turn.role,
		content: [
			{
				type: turn.role === "assistant" ? "output_text" : "input_text",
				text: turn.text,
			},
		],
	})),
});

/**
 * Append a tool call and its result: a `function_call`
 * item (keyed by the call's `call_id`) followed by its
 * `function_call_output`, after the assistant message that
 * carries the round's text. Pure.
 */
const appendToolResult = (
	send: ResponsesSend,
	call: ToolCallData,
	result: string,
): unknown => {
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
				type: "function_call" as const,
				call_id: call.id,
				name: call.name,
				arguments: call.args,
			},
			{
				type: "function_call_output" as const,
				call_id: call.id,
				output: result,
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
	seedHistory,
	appendToolResult,
	headers: bearerHeaders,
	send: (ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
		sendStream(
			`${ctx.apiUrl}${endpoint}`,
			buildRequest(
				ctx.prev === undefined
					? responsesSendMinTemplate
					: (ctx.prev as ResponsesSend),
				ctx,
			),
			bearerHeaders(ctx.apiKey),
		),
} satisfies Provider<ResponsesSend>;
