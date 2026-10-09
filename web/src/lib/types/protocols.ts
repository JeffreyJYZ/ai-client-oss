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
			z.object({
				type: z.string(),
				max_num_results: z.number(),
			}),
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
});
export type ChatCompletionsSend = z.infer<typeof ChatCompletionsSend>;

export const protocolsURL = {
	chatcompletions: "/chat/completions",
	responses: "/responses",
};
