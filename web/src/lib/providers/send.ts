import type { Chunk } from "@lib/providers/types";
import { Effect, Stream } from "effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

/**
 * A fragment-correlation key: the string or number the
 * wire uses to match a call's events to each other (a
 * `tool_calls[].index`, a content block `index`).
 */
const asKey = (value: unknown): string | null =>
	typeof value === "string"
		? value
		: typeof value === "number"
			? String(value)
			: null;

/**
 * The first `tool_calls` delta entry that carries data,
 * or `null` when the delta carries none. The opening
 * entry carries `index`, `id` and `function.name` (with
 * an empty/absent `arguments`); continuation entries
 * carry only `index` and a `function.arguments`
 * fragment. Multiple calls can be in flight at once
 * (different `index`); a delta that opens several calls
 * at once registers only the first — which is what
 * providers send in practice, one entry per delta.
 */
const toolCallEntry = (
	delta: Record<string, unknown>,
): {
	readonly key: string;
	readonly id: string;
	readonly name: string;
	readonly args: string;
} | null => {
	const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
	for (const call of calls) {
		if (!isRecord(call)) continue;
		const fn = isRecord(call.function) ? call.function : undefined;
		const name = fn === undefined ? null : asString(fn.name);
		const args = fn === undefined ? null : asString(fn.arguments);
		if ((name === null || name === "") && (args === null || args === "")) {
			continue;
		}
		const key = asKey(call.index);
		const id = asString(call.id);
		return {
			key: key === null ? "" : key,
			id: id === null ? "" : id,
			name: name === null ? "" : name,
			args: args === null ? "" : args,
		};
	}
	return null;
};

/**
 * The visible text carried by a chat/completions
 * `delta.reasoning_details` array — OpenRouter's structured
 * thinking shape. Each element is a typed fragment: a
 * `reasoning.text` (its `text`) or a `reasoning.summary`
 * (its `summary`) is renderable, and the full trace is rebuilt
 * by concatenating the fragments in array order — they are
 * fragments, not cumulative copies, so nothing is deduplicated
 * or compared. A `reasoning.encrypted` element is never
 * emitted: its `data` payload is base64 (and may carry
 * `[REDACTED]`), so it holds no renderable text. `null` when
 * the delta carries no `reasoning_details` array.
 */
const reasoningDetailsText = (
	delta: Record<string, unknown>,
): string | null => {
	const details = Array.isArray(delta.reasoning_details)
		? delta.reasoning_details
		: null;
	if (details === null) return null;
	let text = "";
	for (const detail of details) {
		if (!isRecord(detail)) continue;
		// Encrypted reasoning is base64 (possibly `[REDACTED]`)
		// — never renderable, so it is dropped rather than
		// spliced into the trace.
		if (detail.type === "reasoning.encrypted") continue;
		const visible =
			detail.type === "reasoning.summary"
				? asString(detail.summary)
				: detail.type === "reasoning.text"
					? asString(detail.text)
					: null;
		if (visible !== null) text += visible;
	}
	return text;
};

/**
 * Parse one SSE line into a tagged chunk, total and pure. `null` for anything
 * that carries no visible text (blanks, `[DONE]`, non-`data:` lines, unknown
 * shapes). Three envelopes are understood:
 *
 * - **Responses** — a top-level `delta`; the event `type` tags it: a `type`
 *   containing `reasoning` (`response.reasoning_summary_text.delta`) is
 *   thinking, anything else (`response.output_text.delta`) is the answer. A
 *   function call opens with an `output_item.added` whose `item.type` is
 *   `function_call` (name on the item); its arguments stream as
 *   `function_call_arguments` deltas (raw JSON, never answer text, keyed by
 *   the item's `id`) and finalize in a `function_call_arguments.done` event
 *   carrying the whole JSON.
 * - **chat/completions** — `choices[0].delta.reasoning_details` (OpenRouter's
 *   typed array: `reasoning.text` and `reasoning.summary` fragments,
 *   concatenated in array order; `reasoning.encrypted` is base64 and never
 *   renderable) or `choices[0].delta.reasoning_content` (or `.reasoning`) is
 *   thinking; `choices[0].delta.content` or `choices[0].text` is the answer;
 *   `choices[0].delta.tool_calls` opens a tool call (the first entry carries
 *   the `index`, `id` and `function.name`, later entries carry `index` plus an
 *   `arguments` fragment).
 * - **Anthropic Messages** — a `content_block_start` opens a content
 *   block; `tool_use` (a client tool) announces the tool by name and its
 *   arguments stream as `input_json_delta` fragments until the block's
 *   `content_block_stop`; `server_tool_use` (the built-in web search)
 *   announces itself by name only. A `content_block_delta` carries the answer
 *   (`text_delta`) and thinking (`thinking_delta`) in its `delta`.
 *
 * Tool-call events yield the `tool` display marker (unchanged, now carrying
 * the call's identity) and `tool_arg` fragments; `accumulateToolCalls`
 * assembles those into `tool_call` chunks.
 */
export const parseLine = (line: string): Chunk | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return null;
	const payload = trimmed.slice("data:".length).trim();
	if (payload === "" || payload === "[DONE]") return null;
	const event = JSON.parse(payload) as {
		type?: unknown;
		delta?: unknown;
		choices?: unknown;
		item?: unknown;
		item_id?: unknown;
		arguments?: unknown;
		index?: unknown;
		content_block?: unknown;
	};

	if (typeof event.delta === "string") {
		const type = asString(event.type) ?? "";
		// A streamed function call's arguments are raw JSON, not the reply —
		// tagging them `text` would splice them into the answer. The
		// Responses protocol keys each fragment by the item it belongs to.
		if (type.includes("function_call_arguments")) {
			const itemId = asString(event.item_id);
			return itemId === null
				? null
				: {
						kind: "tool_arg" as const,
						text: "",
						call: { id: "", key: itemId, name: "", args: event.delta },
					};
		}
		return {
			kind: type.includes("reasoning") ? "reasoning" : "text",
			text: event.delta,
		};
	}

	const type = asString(event.type) ?? "";
	// Responses tools surface outside the text stream: a web search announces
	// itself as it starts, a function call arrives as a named output item.
	if (type.includes("web_search_call") && type.includes("in_progress")) {
		return { kind: "tool", text: "web_search" };
	}
	// A function call's arguments are finalized in one event
	// carrying the whole JSON — still raw JSON, never the reply.
	if (type.includes("function_call_arguments") && type.includes("done")) {
		const itemId = asString(event.item_id);
		const args = asString(event.arguments);
		return itemId === null || args === null
			? null
			: {
					kind: "tool_arg" as const,
					text: "",
					call: { id: "", key: itemId, name: "", args, complete: true },
				};
	}
	if (isRecord(event.item) && event.item.type === "function_call") {
		// `.added` and `.done` both carry the item; only the first opens a call,
		// so gate on `added` or every function call yields two markers.
		if (!type.includes("output_item.added")) return null;
		const name = asString(event.item.name);
		if (name === null) return null;
		// The item's `id` keys its argument events (they arrive as
		// `item_id`); the `call_id` is the id a tool result is
		// correlated with. An endpoint that omits one falls back
		// to the other.
		const itemId = asString(event.item.id);
		const callId = asString(event.item.call_id);
		const key = itemId === null ? (callId ?? "") : itemId;
		return {
			kind: "tool",
			text: name,
			call: { id: callId ?? key, key, name, args: "" },
		};
	}

	// Anthropic Messages stream. A `content_block_start` opens a
	// content block: `tool_use` (a client tool) announces the
	// tool by name, then the call's arguments stream as
	// `input_json_delta` — raw JSON, not the reply — until the
	// block's `content_block_stop` closes it. `server_tool_use`
	// (the built-in web search) announces itself by name; its
	// input is not a client call. A `content_block_delta`
	// carries the answer (`text_delta`) and thinking
	// (`thinking_delta`); its other delta types carry no answer
	// text. These event types are disjoint from the OpenAI
	// envelopes above.
	if (type === "content_block_start" && isRecord(event.content_block)) {
		const block = event.content_block;
		if (block.type === "tool_use") {
			const name = asString(block.name);
			if (name === null) return null;
			// The block's `index` correlates its deltas and its
			// stop event; the block's `id` is the id a tool
			// result is correlated with.
			const id = asString(block.id);
			const key = asKey(event.index);
			return {
				kind: "tool",
				text: name,
				call: {
					id: id === null ? "" : id,
					key: key === null ? "" : key,
					name,
					args: "",
				},
			};
		}
		if (block.type === "server_tool_use") {
			const name = asString(block.name);
			return name === null ? null : { kind: "tool", text: name };
		}
		return null;
	}
	if (type === "content_block_delta") {
		const delta = isRecord(event.delta) ? event.delta : undefined;
		const deltaType = delta === undefined ? null : asString(delta.type);
		if (deltaType === "text_delta") {
			const text = asString(delta?.text);
			return text === null ? null : { kind: "text", text };
		}
		if (deltaType === "thinking_delta") {
			const thinking = asString(delta?.thinking);
			return thinking === null ? null : { kind: "reasoning", text: thinking };
		}
		// A tool call's argument fragment, keyed by the content
		// block it belongs to.
		if (deltaType === "input_json_delta") {
			const partial = asString(delta?.partial_json);
			const key = asKey(event.index);
			return partial === null || key === null
				? null
				: {
						kind: "tool_arg" as const,
						text: "",
						call: { id: "", key, name: "", args: partial },
					};
		}
		return null;
	}
	// A `content_block_stop` closes the block its `index`
	// names: whatever a tool call has accumulated into that
	// block is its complete input. Stops of blocks that
	// opened no client call match nothing and accumulate to
	// nothing.
	if (type === "content_block_stop") {
		const key = asKey(event.index);
		return key === null
			? null
			: {
					kind: "tool_arg" as const,
					text: "",
					call: { id: "", key, name: "", args: "", complete: true },
				};
	}

	const choices = Array.isArray(event.choices) ? event.choices : [];
	const choice = choices[0];
	if (!isRecord(choice)) return null;

	const delta = isRecord(choice.delta) ? choice.delta : undefined;
	const content = delta === undefined ? null : asString(delta.content);
	const details = delta === undefined ? null : reasoningDetailsText(delta);
	// `reasoning_details` wins when it carried visible text:
	// the flat `reasoning`/`reasoning_content` strings on the
	// same delta are the same words and would append twice.
	const reasoning =
		details !== null && details !== ""
			? details
			: delta === undefined
				? null
				: (asString(delta.reasoning_content) ?? asString(delta.reasoning));

	if (reasoning !== null && reasoning !== "") {
		return { kind: "reasoning", text: reasoning };
	}
	if (content !== null) return { kind: "text", text: content };
	const entry = delta === undefined ? null : toolCallEntry(delta);
	if (entry !== null) {
		// The opening entry names the call: the display marker
		// carries the call's identity so the accumulator can
		// register it while the marker passes through.
		if (entry.name !== "") {
			return {
				kind: "tool",
				text: entry.name,
				call: {
					id: entry.id,
					key: entry.key,
					name: entry.name,
					args: entry.args,
				},
			};
		}
		// A continuation entry carries one argument fragment.
		return {
			kind: "tool_arg",
			text: "",
			call: { id: "", key: entry.key, name: "", args: entry.args },
		};
	}
	if (reasoning !== null) return { kind: "reasoning", text: reasoning };

	const text = asString(choice.text);
	return text === null ? null : { kind: "text", text };
};

const parseLineSafe = (line: string): Effect.Effect<Chunk | null> =>
	Effect.try({
		try: () => parseLine(line),
		catch: () => null,
	}).pipe(Effect.orElseSucceed((): Chunk | null => null));

/** A call being assembled from its streamed fragments. */
interface PendingCall {
	readonly key: string;
	readonly id: string;
	readonly name: string;
	args: string;
}

/**
 * The calls in flight, keyed by the protocol's fragment
 * key, in arrival order (a `Map`'s insertion order, so
 * the end-of-stream flush emits them in the order the
 * model opened them).
 */
interface ToolAccumState {
	readonly pending: Map<string, PendingCall>;
}

/** The completed call, as the one chunk the caller acts on. */
const toolCallChunk = (pending: PendingCall): Chunk => ({
	kind: "tool_call",
	text: pending.name,
	call: {
		id: pending.id,
		key: pending.key,
		name: pending.name,
		args: pending.args,
	},
});

/**
 * Assemble streamed tool-call fragments into complete
 * calls. Consumes every `tool_arg` chunk, passes every
 * other chunk through untouched (the `tool` display
 * markers included), and emits one `tool_call` chunk
 * with the complete argument JSON as soon as the
 * protocol signals the call is done — a Responses
 * `function_call_arguments.done` event (which carries
 * the whole JSON) or an Anthropic `content_block_stop`.
 * chat/completions has no such signal, so its calls
 * complete — with whatever arguments have arrived —
 * when the stream ends (`onHalt`), as does anything
 * still pending on any protocol. The state is created
 * per stream run, so every request accumulates
 * independently; nothing is module-level.
 */
export const accumulateToolCalls = (
	stream: Stream.Stream<Chunk, string>,
): Stream.Stream<Chunk, string> =>
	stream.pipe(
		Stream.mapAccum(
			(): ToolAccumState => ({ pending: new Map() }),
			(
				state: ToolAccumState,
				chunk: Chunk,
			): readonly [ToolAccumState, readonly Chunk[]] => {
				const call = chunk.call;
				// Text, reasoning, the web-search marker and an
				// already-complete call carry no fragment to
				// accumulate: everything passes through.
				if (call === undefined || chunk.kind === "tool_call") {
					return [state, [chunk]];
				}
				// The display marker that opens a call carries the
				// call's identity: register it and let it through.
				if (chunk.kind === "tool") {
					state.pending.set(call.key, {
						key: call.key,
						id: call.id,
						name: call.name,
						args: call.args,
					});
					return [state, [chunk]];
				}
				// A `tool_arg` fragment. A key with no open call is
				// input of something the client does not execute (the
				// built-in search, say) or a malformed stream — there
				// is nothing to accumulate or emit.
				const pending = state.pending.get(call.key);
				if (pending === undefined) return [state, []];
				if (call.complete) {
					// The arguments are final: a `done` event carries
					// them whole, a block `stop` leaves whatever has
					// accumulated.
					if (call.args !== "") pending.args = call.args;
					state.pending.delete(call.key);
					return [state, [toolCallChunk(pending)]];
				}
				pending.args += call.args;
				return [state, []];
			},
			{
				// The stream ended: emit whatever is still pending, so a
				// call whose arguments never completed still surfaces as
				// a complete-as-known call.
				onHalt: (state: ToolAccumState): readonly Chunk[] =>
					[...state.pending.values()].map(toolCallChunk),
			},
		),
	);

/**
 * Headers for OpenAI-shaped endpoints: a JSON body plus a Bearer
 * key when one is set. A local server needs no key, and an empty
 * value would send "Bearer ". Endpoints that authenticate
 * differently (Anthropic sends `x-api-key`) pass their own header
 * set to `sendStream`.
 */
export const bearerHeaders = (
	apiKey: string | undefined,
): Record<string, string> => {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (apiKey !== undefined && apiKey !== "")
		headers.authorization = `Bearer ${apiKey}`;
	return headers;
};

export const sendStream = (
	url: string,
	body: unknown,
	headers: Record<string, string>,
): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				}),
			catch: (cause) => String(cause),
		});

		if (!response.ok) {
			const detail = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => "",
			});
			return yield* Effect.fail(`HTTP ${response.status}: ${detail}`);
		}

		const raw = response.body;
		if (raw === null) return yield* Effect.fail("response has no body");

		return Stream.fromReadableStream<Uint8Array, string>({
			evaluate: () => raw,
			onError: (cause) => String(cause),
		}).pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.mapEffect(parseLineSafe),
			Stream.filter((chunk): chunk is Chunk => chunk !== null),
			accumulateToolCalls,
		);
	});
