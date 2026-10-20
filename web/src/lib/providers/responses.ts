import { parseResponsesSend } from "@lib/core/parse";
import { requestTools } from "@lib/providers/presets";
import { bearerHeaders, sendStream } from "@lib/providers/send";
import type {
	AttachmentPart,
	Chunk,
	HistoryTurn,
	Provider,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { isTurnReplay, responsesVariant } from "@lib/providers/variant";
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
	// The active variant's parameters, mapped to this protocol's field names.
	const variant = responsesVariant(ctx.variant);
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
		// The active variant's parameters, mapped to this protocol's field names
		// (the token cap is `max_output_tokens` here, and the effort is nested
		// under `reasoning`). Written on the turn's fresh composition only:
		// the tool loop replays the turn's own body, which already carries
		// these parameters, so re-writing them there would clobber a
		// `transformBody` stage's own value for the same field and break the
		// replay's identity. On the fresh composition they are written
		// explicitly, the unset ones as `undefined` (dropped at
		// `JSON.stringify`): a value inherited from the previous turn's body
		// — a removed variant's parameter — cannot survive into this turn, and
		// a parameter the variant does not set is not sent at all, so the
		// endpoint's own default stands.
		...(isTurnReplay(ctx)
			? {}
			: {
					temperature: variant.temperature,
					top_p: variant.top_p,
					max_output_tokens: variant.max_output_tokens,
					reasoning: variant.reasoning,
				}),
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
 * One attachment as the Responses input item
 * `buildRequest` writes: images and files share the
 * `file_url` shape, differing only in item type.
 */
const partsBlocks = (parts: readonly AttachmentPart[]) =>
	parts.map((part) =>
		part.kind === "image"
			? { type: "input_image" as const, file_url: part.dataUrl }
			: { type: "input_file" as const, file_url: part.dataUrl },
	);

/**
 * Rebuild a Responses body from the conversation's text
 * turns: every turn rides as an `input` item — user turns
 * as `input_text`, assistant turns as `output_text`, the
 * shapes `buildRequest` and `appendAssistant` write. A turn
 * with attachments carries them as the `input_image`/
 * `input_file` items `buildRequest` writes, after the text
 * item — so the seed of a stored conversation equals the
 * body its successful turns left behind. Pure.
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
			...partsBlocks(turn.parts ?? []),
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
			// The conversation's session id, for an endpoint that needs one
			// (`x-opencode-session`).
			ctx.conversationId,
		),
} satisfies Provider<ResponsesSend>;
