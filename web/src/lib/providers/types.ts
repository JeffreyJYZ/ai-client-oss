import type { Effect, Stream } from "effect";
import type { z } from "zod";

export interface Chunk {
	readonly kind: "text" | "reasoning" | "tool";
	/**
	 * Visible text for `text`/`reasoning`; for `tool`, the called tool's name
	 * (used to render a marker at the call site).
	 */
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

/** How an endpoint serves web search on the wire. */
export type SearchKind = "openai" | "openrouter";

/** An enabled web-search request: the endpoint's mechanism plus the result cap. */
export interface SearchSpec {
	readonly kind: SearchKind;
	readonly maxResults: number;
}

export interface SendCtx {
	readonly msg: string;
	readonly prev: unknown;
	readonly apiUrl: string;
	readonly apiKey?: string;
	readonly model: string;
	readonly parts?: readonly AttachmentPart[];
	readonly tools?: readonly ToolSpec[];
	/** Web-search request, when the endpoint has a mechanism for it. */
	readonly search?: SearchSpec;
	/** Per-conversation system prompt; absent/blank sends none. */
	readonly systemPrompt?: string;
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
