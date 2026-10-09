import type { Effect, Stream } from "effect";
import type { z } from "zod";

export interface Chunk {
	readonly text: string;
}

export interface AttachmentPart {
	readonly kind: "image" | "file";
	readonly name: string;
	readonly dataUrl: string;
}

export interface ToolSpec {
	readonly type: string;
	readonly max_num_results: number;
}

export interface SendCtx {
	readonly msg: string;
	readonly prev: unknown;
	readonly apiUrl: string;
	readonly apiKey?: string;
	readonly model: string;
	readonly parts?: readonly AttachmentPart[];
	readonly tools?: readonly ToolSpec[];
}

export interface Provider<Send> {
	readonly schema: z.ZodType<Send>;
	readonly endpoint: string;
	readonly template: Send;
	parse(raw: unknown): Effect.Effect<Send, string>;
	buildRequest(send: Send, ctx: SendCtx): unknown;
	/**
	 * Append the streamed assistant reply to a request body, returning the new
	 * body. Feeds the assistant's own turns back into the next request so
	 * multi-turn context includes what the model previously said. Pure.
	 */
	appendAssistant(send: Send, text: string): unknown;
	send(ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string>;
}
