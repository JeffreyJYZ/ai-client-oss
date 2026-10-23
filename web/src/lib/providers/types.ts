import type { ToolDeclaration } from "@lib/plugins/tools";
import type { VariantParams } from "@lib/providers/variant";
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
	/**
	 * Send this endpoint's app-attribution headers (OpenRouter's referer/title
	 * pair, see `attributionHeadersFor`). Absent reads as on, so a request built
	 * before the toggle existed is unchanged; `false` drops them.
	 */
	readonly attribution?: boolean;
	/**
	 * TinyFish API key, when the user has one set. Declares
	 * the client-side `web_search` tool (where the endpoint
	 * has no search of its own) and routes `fetch_url`
	 * through the TinyFish Fetch API first. Absent or blank:
	 * no search declaration and the app's own fetch only.
	 */
	readonly tinyfishApiKey?: string;
	/**
	 * The **registered** tools this request announces — read once per turn from
	 * the host's tool registry and threaded here because `buildRequest` is pure
	 * and synchronous. Each entry is a tool's own wire declaration, so the name,
	 * description and JSON Schema a request declares are exactly what the model
	 * loop resolves a call through. Absent or empty declares none.
	 *
	 * The registry's policy-governed built-ins are expected to be in here too:
	 * `requestTools` drops the names host policy owns (`fetch_url`, the
	 * client-side `web_search`) when it assembles the body, so a caller passes
	 * every entry and those two are instead declared from `ctx.fetchTool` and
	 * `ctx.tinyfishApiKey` — never twice, and never when their toggle is off.
	 */
	readonly registeredTools?: readonly ToolDeclaration[];
	/** Per-conversation system prompt; absent/blank sends none. */
	readonly systemPrompt?: string;
	/**
	 * The conversation this request belongs to — the store's own id for it,
	 * threaded from `state/chat.ts` (`send` already holds it) so a request to an
	 * endpoint that needs a per-conversation session (OpenCode's
	 * `x-opencode-session`) is sent that conversation's own stable id (see
	 * `sessionHeadersFor`). Absent only for a request that belongs to no
	 * conversation, e.g. the Settings connection probe.
	 */
	readonly conversationId?: string;
	/**
	 * The active variant's parameters, when one is active: the generation
	 * parameters this request carries (`lib/providers/variant.ts`). Absent
	 * when no variant is active — then the request carries no parameter at
	 * all and the endpoint's own defaults stand.
	 */
	readonly variant?: VariantParams;
	/**
	 * Set by the tool loop from its second round on: the request
	 * replays the body round 1 sent, which already carries the
	 * turn's user message, so `buildRequest` must not append
	 * `ctx.msg` again — the question would reach the model once
	 * per tool round. Absent or `false` (every fresh turn)
	 * appends the message as the final user turn.
	 *
	 * This is the requirement every protocol's `buildRequest` must
	 * satisfy: **idempotence under `skipUserMessage`** — building over
	 * a body that already carries the turn's user message reproduces
	 * that body unchanged (appends nothing). The single-body turn in
	 * `state/chat.ts` is built on it.
	 */
	readonly skipUserMessage?: boolean;
}

/**
 * One turn of a conversation, the minimal shape a
 * history seed needs: the stored message's role, its
 * marker-free `text`, and the attachments it carried.
 * Display markers are left behind. `error` rows never
 * reach a seed — the caller skips them, since they are
 * the app's own words and no wire role matches them.
 */
export interface HistoryTurn {
	readonly role: "user" | "assistant";
	readonly text: string;
	/**
	 * Attachments the turn carried, replayed as the
	 * protocol's own attachment blocks. Absent or empty
	 * for a text-only turn, whose wire shape is the
	 * plain string (or single text item) as before.
	 */
	readonly parts?: readonly AttachmentPart[];
}

export interface Provider<Send> {
	readonly schema: z.ZodType<Send>;
	readonly endpoint: string;
	readonly template: Send;
	parse(raw: unknown): Effect.Effect<Send, string>;
	/**
	 * Build the request body for one send from the template (or a replayed
	 * body) and `ctx`. **Idempotent under `skipUserMessage`:** with
	 * `ctx.skipUserMessage` set the body already carries the turn's user
	 * message, so building over it must append nothing — the same body in, the
	 * same body out. The single-body tool loop depends on this: it builds the
	 * turn's body once, replays it as `prev` for every round with
	 * `skipUserMessage`, and stores exactly what it sent, so a builder that
	 * appended the message again would repeat the question once per round and
	 * drift the sent body from the stored one. Pure.
	 */
	buildRequest(send: Send, ctx: SendCtx): unknown;
	/**
	 * Append the streamed assistant reply to a request body, returning the new
	 * body. Feeds the assistant's own turns back into the next request so
	 * multi-turn context includes what the model previously said. Pure.
	 */
	appendAssistant(send: Send, text: string): unknown;
	/**
	 * Rebuild a request body from the conversation's
	 * turns — the inverse of `appendAssistant`: the seed
	 * `buildRequest` then extends exactly as it extends a
	 * body replayed from a previous turn, and a turn list
	 * ending in an assistant turn seeds to the same body
	 * `appendAssistant` produces over the seed of the turns
	 * before it. Pure; takes bare `HistoryTurn`s so no
	 * provider depends on `lib/db`. A turn's attachments
	 * ride as the protocol's own attachment blocks, so a
	 * turn that carried only a file survives the rebuild.
	 * Callers skip `error` rows.
	 */
	seedHistory(turns: readonly HistoryTurn[]): Send;
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
