import { z } from "zod";

export const MsgRole = z.enum(["user", "assistant", "system"]);
export type MsgRole = z.infer<typeof MsgRole>;

export const InputTypes = z.enum([
	"input_text",
	"input_file",
	"input_image",
	"output_text",
]);
export type InputTypes = z.infer<typeof InputTypes>;

export const ResponsesSend = z.object({
	model: z.string(),
	instructions: z.string().optional(),
	tools: z
		.array(
			z.union([
				z.object({
					type: z.string(),
					max_num_results: z.number(),
				}),
				// The server-tool declaration OpenRouter uses
				// (`openrouter:web_search`), which carries `parameters`.
				z.object({
					type: z.string(),
					parameters: z.object({ max_results: z.number() }),
				}),
			]),
		)
		.optional(),
	input: z.union([
		z.array(
			z.object({
				role: MsgRole,
				content: z.array(
					z.object({
						type: InputTypes,
						text: z.string().optional(),
						file_url: z.string().optional(),
						detail: z.union([z.string(), z.boolean()]).optional(),
					}),
				),
			}),
		),
		z.string(),
	]),
	stream: z.boolean(),
});
export type ResponsesSend = z.infer<typeof ResponsesSend>;

export const ChatCompletionsSend = z.object({
	model: z.string(),
	// The request body always sets this (see `chatCompletions.buildRequest`);
	// optional only so a replayed/template body without it still parses.
	stream: z.boolean().optional(),
});
export type ChatCompletionsSend = z.infer<typeof ChatCompletionsSend>;

export const AnthropicRole = z.enum(["user", "assistant"]);
export type AnthropicRole = z.infer<typeof AnthropicRole>;

/**
 * The Anthropic Messages API request body. `model`, `max_tokens` and
 * `messages` are required by the API; the system prompt is the
 * top-level `system` parameter (the API has no "system" message
 * role). `tools` carries the built-in `web_search` server tool or a
 * client tool declaration.
 */
export const AnthropicSend = z.object({
	model: z.string(),
	max_tokens: z.number(),
	system: z.string().optional(),
	messages: z.array(
		z.object({
			role: AnthropicRole,
			content: z.union([
				z.string(),
				z.array(
					z.object({
						type: z.string(),
						text: z.string().optional(),
						source: z
							.object({
								type: z.string(),
								media_type: z.string(),
								data: z.string(),
							})
							.optional(),
					}),
				),
			]),
		}),
	),
	tools: z.array(z.unknown()).optional(),
	stream: z.boolean(),
});
export type AnthropicSend = z.infer<typeof AnthropicSend>;

export const protocolsURL = {
	anthropic: "/messages",
	chatcompletions: "/chat/completions",
	responses: "/responses",
};
