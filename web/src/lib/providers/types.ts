import type { Effect, Stream } from "effect";
import type { z } from "zod";

/**
 * A tool call as the model streams it. `tool_arg` fragments
 * carry what one event delivered; `tool_call` carries the
 * assembled call.
 */
export interface ToolCallData {
	/**
	 * The id the caller correlates the call's result with — the
	 * wire id from the event that opened the call
	 * (`tool_calls[].id` on chat/completions, the output item's
	 * `call_id` on Responses, the content block's `id` on
	 * Anthropic).
	 */
	readonly id: string;
	/**
	 * Key that correlates the call's streamed fragments: the
	 * `tool_calls[].index` on chat/completions, the output
	 * item's `id` on Responses (carried by every argument
	 * event as `item_id`), the content block `index` on
	 * Anthropic.
	 */
	readonly key: string;
	/** The called tool's name. */
	readonly name: string;
	/**
	 * The call's arguments: one fragment on a `tool_arg`, the
	 * whole JSON on a `tool_call`.
	 */
	readonly args: string;
	/**
	 * The arguments parsed to a value, set by the loop that
	 * executes the call (it parses them to read the call's
	 * parameters). Absent on a streamed call; Anthropic's
	 * `tool_use` block carries the parsed object as its `input`.
	 */
	readonly input?: unknown;
	/**
	 * True when the protocol signals the arguments are final —
	 * a Responses `function_call_arguments.done` (which carries
	 * them whole) or an Anthropic `content_block_stop`. Absent
	 * on chat/completions, which has no such event: its calls
	 * complete when the stream ends.
	 */
	readonly complete?: boolean;
}

export interface Chunk {
	readonly kind:
		| "text"
		| "reasoning"
		| "tool"
		/** One streamed tool-call argument fragment (internal). */
		| "tool_arg"
		/** A complete tool call, ready to act on. */
		| "tool_call";
	/**
	 * Visible text for `text`/`reasoning`; for `tool` and
	 * `tool_call`, the called tool's name (used to render a
	 * marker at the call site); "" on `tool_arg` fragments,
	 * which carry no text of their own.
	 */
	readonly text: string;
	/**
	 * Call data on `tool_arg` (one streamed fragment) and
	 * `tool_call` (the complete call), and on the `tool` marker
	 * that opens a call — the accumulator registers the call
	 * from it while the marker passes through.
	 */
	readonly call?: ToolCallData;
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
export type SearchKind = "openai" | "openrouter" | "anthropic";

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
	/**
	 * Declare the built-in `fetch_url` tool on the wire. Absent
	 * or `false` sends none; a later step sets it from a
	 * Settings toggle.
	 */
	readonly fetchTool?: boolean;
	/** Per-conversation system prompt; absent/blank sends none. */
	readonly systemPrompt?: string;
	/**
	 * Set by the tool loop from its second round on: the request
	 * replays the body round 1 sent, which already carries the
	 * turn's user message, so `buildRequest` must not append
	 * `ctx.msg` again — the question would reach the model once
	 * per tool round. Absent or `false` (every fresh turn)
	 * appends the message as the final user turn.
	 */
	readonly skipUserMessage?: boolean;
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
	/**
	 * Append one tool call and its result to a request body,
	 * returning the new body: the call joins the round's assistant
	 * message and the result follows it, in the protocol's shape
	 * (chat/completions: `tool_calls` on the assistant message plus
	 * a `role: "tool"` message; Responses: a `function_call` item
	 * plus its `function_call_output`; Anthropic: a `tool_use`
	 * block plus a user `tool_result` block). `call.input` carries
	 * the arguments parsed by the executing loop; `failed` marks a
	 * failed execution — only Anthropic's `tool_result` has an
	 * error flag for it, so the implementations that do not use it
	 * simply take fewer parameters. Pure.
	 */
	appendToolResult(
		send: Send,
		call: ToolCallData,
		result: string,
		failed?: boolean,
	): unknown;
	/**
	 * Auth and version headers for this endpoint (Bearer for the OpenAI
	 * shapes, `x-api-key` for Anthropic). `send` uses it, and so do the
	 * models/connection helpers — the endpoint owns its own auth.
	 */
	headers(apiKey: string | undefined): Record<string, string>;
	send(ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string>;
}
