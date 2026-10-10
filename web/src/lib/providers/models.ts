import { type ProtocolName, providers } from "@lib/providers";
import { Effect } from "effect";

interface ModelsPayload {
	readonly data?: readonly { readonly id?: unknown }[];
}

/**
 * `GET ${baseUrl}/models` — the OpenAI list endpoint (`baseUrl` carries the
 * version, so no `/v1` here). Auth comes from the endpoint itself, so an
 * Anthropic provider sends `x-api-key` rather than a Bearer token. A
 * non-2xx response or a transport failure becomes the `string` error
 * channel.
 */
export const listModels = (
	protocol: ProtocolName,
	baseUrl: string,
	apiKey: string | undefined,
): Effect.Effect<string[], string> =>
	Effect.gen(function* () {
		const headers: Record<string, string> = {
			accept: "application/json",
			...providers[protocol].headers(apiKey),
		};

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

/**
 * `POST ${baseUrl}${providers[protocol].endpoint}` with a 1-token-capped body
 * (`max_output_tokens`/`max_tokens: 1`), a real generation that proves the
 * selected model answers. The response stream is never read — a 2xx is enough,
 * so the body is cancelled to release the connection. A non-2xx response or a
 * transport failure becomes the `string` error channel.
 */
export const testModel = (
	protocol: ProtocolName,
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		const headers: Record<string, string> = providers[protocol].headers(apiKey);

		const body =
			protocol === "responses"
				? { model, input: "ping", stream: true, max_output_tokens: 1 }
				: {
						model,
						messages: [{ role: "user", content: "ping" }],
						stream: true,
						max_tokens: 1,
					};

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`${baseUrl}${providers[protocol].endpoint}`, {
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
			return yield* Effect.fail(`${response.status}: ${detail}`);
		}

		yield* Effect.sync(() => {
			void response.body?.cancel();
		});
	});
