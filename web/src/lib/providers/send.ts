import type { Chunk } from "@lib/providers/types";
import { Effect, Stream } from "effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

/**
 * Parse one SSE line into a tagged chunk, total and pure. `null` for anything
 * that carries no visible text (blanks, `[DONE]`, non-`data:` lines, unknown
 * shapes). Two envelopes are understood:
 *
 * - **Responses** — a top-level `delta`; the event `type` tags it: a `type`
 *   containing `reasoning` (`response.reasoning_summary_text.delta`) is
 *   thinking, anything else (`response.output_text.delta`) is the answer.
 * - **chat/completions** — `choices[0].delta.reasoning_content` (or
 *   `.reasoning`) is thinking; `choices[0].delta.content` or `choices[0].text`
 *   is the answer.
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
	};

	if (typeof event.delta === "string") {
		const type = asString(event.type) ?? "";
		return {
			kind: type.includes("reasoning") ? "reasoning" : "text",
			text: event.delta,
		};
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
