import type { HostServices } from "@lib/plugins/host";
import { requireProvider } from "@lib/plugins/providers";
import type { SendCtx } from "@lib/providers/types";
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
 * `POST ${baseUrl}${endpoint}` with a real generation that proves the selected
 * model answers. The probe body is **the protocol's own request shape**, built
 * by its own `buildRequest` from its template — never a hardcoded
 * chat-completions body, which mis-shaped every protocol but `responses` now
 * that protocols are runtime data. The response stream is never read — a 2xx is
 * enough, so the body is cancelled to release the connection. A non-2xx
 * response or a transport failure becomes the `string` error channel.
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

		// The protocol builds its own minimal probe. `buildRequest` is
		// plugin-supplied, so a throw is turned into the `string` channel here
		// rather than escaping as a defect.
		const probe = yield* Effect.try({
			try: () =>
				provider.buildRequest(provider.template, {
					msg: "ping",
					prev: provider.template,
					apiUrl: baseUrl,
					apiKey,
					model,
					fetchTool: false,
				} satisfies SendCtx),
			catch: (cause) =>
				`the "${protocol}" protocol could not build a test request: ${String(cause)}`,
		});

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`${baseUrl}${provider.endpoint}`, {
					method: "POST",
					headers,
					body: JSON.stringify(probe),
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
