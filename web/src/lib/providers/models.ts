import { Effect } from "effect";

interface ModelsPayload {
	readonly data?: readonly { readonly id?: unknown }[];
}

/**
 * `GET ${baseUrl}/models` — the OpenAI list endpoint (`baseUrl` carries the
 * version, so no `/v1` here). The bearer header is sent only when a key is
 * configured; a non-2xx response or a transport failure becomes the `string`
 * error channel.
 */
export const listModels = (
	baseUrl: string,
	apiKey: string | undefined,
): Effect.Effect<string[], string> =>
	Effect.gen(function* () {
		const headers: Record<string, string> = { accept: "application/json" };
		if (apiKey !== undefined && apiKey.trim() !== "") {
			headers.authorization = `Bearer ${apiKey}`;
		}

		const response = yield* Effect.tryPromise({
			try: () => fetch(`${baseUrl}/models`, { headers }),
			catch: (cause) => String(cause),
		});

		if (!response.ok) {
			const detail = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => "",
			});
			return yield* Effect.fail(`HTTP ${response.status}: ${detail}`);
		}

		const payload = yield* Effect.tryPromise({
			try: () => response.json() as Promise<ModelsPayload>,
			catch: (cause) => String(cause),
		});

		return (payload.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string");
	});
