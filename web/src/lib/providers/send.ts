import type { Chunk } from "@lib/providers/types";
import { Effect, Stream } from "effect";

const parseLine = (line: string): Chunk | null => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return null;
	const payload = trimmed.slice("data:".length).trim();
	if (payload === "" || payload === "[DONE]") return null;
	const event = JSON.parse(payload) as { delta?: unknown };
	return typeof event.delta === "string" ? { text: event.delta } : null;
};

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
			Stream.map(parseLine),
			Stream.filter((chunk): chunk is Chunk => chunk !== null),
		);
	});
