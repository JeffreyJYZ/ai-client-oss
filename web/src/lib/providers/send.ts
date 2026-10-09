import type { Chunk } from "@lib/providers/types";
import { Effect, Stream } from "effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

/**
 * Name of the tool a chat/completions `tool_calls` delta opens, or `null` when
 * the delta carries none (argument-only continuation of an already-named call).
 * The opening delta carries `function.name`; later deltas carry only arguments.
 */
const toolCallName = (delta: Record<string, unknown>): string | null => {
	const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
	for (const call of calls) {
		if (!isRecord(call)) continue;
		const fn = isRecord(call.function) ? call.function : undefined;
		const name = fn === undefined ? null : asString(fn.name);
		if (name !== null && name !== "") return name;
	}
	return null;
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
 *   `function_call` (name on the item); its streamed `function_call_arguments`
 *   are raw JSON, never answer text.
 * - **chat/completions** — `choices[0].delta.reasoning_content` (or
 *   `.reasoning`) is thinking; `choices[0].delta.content` or `choices[0].text`
 *   is the answer; `choices[0].delta.tool_calls` opens a tool call.
 */
const parseLine = (line: string): Chunk | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return null;
	const payload = trimmed.slice("data:".length).trim();
	if (payload === "" || payload === "[DONE]") return null;
	const event = JSON.parse(payload) as {
		type?: unknown;
		delta?: unknown;
		choices?: unknown;
		item?: unknown;
	};

	if (typeof event.delta === "string") {
		const type = asString(event.type) ?? "";
		// A streamed function call's arguments are raw JSON, not the reply —
		// tagging them `text` would splice them into the answer.
		if (type.includes("function_call_arguments")) return null;
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
	if (isRecord(event.item) && event.item.type === "function_call") {
		// `.added` and `.done` both carry the item; only the first opens a call,
		// so gate on `added` or every function call yields two markers.
		if (!type.includes("output_item.added")) return null;
		const name = asString(event.item.name);
		return name === null ? null : { kind: "tool", text: name };
	}

	const choices = Array.isArray(event.choices) ? event.choices : [];
	const choice = choices[0];
	if (!isRecord(choice)) return null;

	const delta = isRecord(choice.delta) ? choice.delta : undefined;
	const content = delta === undefined ? null : asString(delta.content);
	const reasoning =
		delta === undefined
			? null
			: (asString(delta.reasoning_content) ?? asString(delta.reasoning));

	if (reasoning !== null && reasoning !== "") {
		return { kind: "reasoning", text: reasoning };
	}
	if (content !== null) return { kind: "text", text: content };
	const toolName = delta === undefined ? null : toolCallName(delta);
	if (toolName !== null) return { kind: "tool", text: toolName };
	if (reasoning !== null) return { kind: "reasoning", text: reasoning };

	const text = asString(choice.text);
	return text === null ? null : { kind: "text", text };
};

const parseLineSafe = (line: string): Effect.Effect<Chunk | null> =>
	Effect.try({
		try: () => parseLine(line),
		catch: () => null,
	}).pipe(Effect.orElseSucceed((): Chunk | null => null));

export const sendStream = (
	url: string,
	apiKey: string | undefined,
	body: unknown,
): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
	Effect.gen(function* () {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

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
		);
	});
