import type { HostServices } from "@lib/plugins/host";
import { type AnyProvider, resolveProvider } from "@lib/plugins/providers";
import { Effect, Option } from "effect";

interface ModelsPayload {
	readonly data?: readonly { readonly id?: unknown }[];
}

/**
 * The endpoint helpers resolve their protocol through the registry (spec §5),
 * so a protocol a plugin registered gets its own headers and path. An unknown
 * name fails with the same sentence `SendMsg` uses — never a `TypeError` on an
 * absent provider.
 */
const requireProvider = (
	protocol: string,
): Effect.Effect<AnyProvider, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* resolveProvider(protocol);
		if (Option.isNone(provider)) {
			return yield* Effect.fail(`unknown protocol: ${protocol}`);
		}
		return provider.value;
	});

/**
 * `GET ${baseUrl}/models` — the OpenAI list endpoint (`baseUrl` carries the
 * version, so no `/v1` here). Auth comes from the endpoint itself, so an
 * Anthropic provider sends `x-api-key` rather than a Bearer token. A
 * non-2xx response or a transport failure becomes the `string` error
 * channel.
 */
export const listModels = (
	protocol: string,
	baseUrl: string,
	apiKey: string | undefined,
): Effect.Effect<string[], string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		const headers: Record<string, string> = {
			accept: "application/json",
			...provider.headers(apiKey),
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
 * `POST ${baseUrl}${endpoint}` with a 1-token-capped body
 * (`max_output_tokens`/`max_tokens: 1`), a real generation that proves the
 * selected model answers. The response stream is never read — a 2xx is enough,
 * so the body is cancelled to release the connection. A non-2xx response or a
 * transport failure becomes the `string` error channel.
 */
export const testModel = (
	protocol: string,
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
): Effect.Effect<void, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		const headers: Record<string, string> = provider.headers(apiKey);

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
				fetch(`${baseUrl}${provider.endpoint}`, {
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
