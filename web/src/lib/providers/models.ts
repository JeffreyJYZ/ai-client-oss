import type { HostServices } from "@lib/plugins/host";
import { requireProvider } from "@lib/plugins/providers";
import type { SendCtx } from "@lib/providers/types";
import { Cause, Effect, Option, Result } from "effect";

interface ModelsPayload {
	readonly data?: readonly { readonly id?: unknown }[];
}

/**
 * `String(cause)` that cannot itself throw. A plugin supplies whatever it
 * throws (and the rejection reason of a `fetch` whose plugin-supplied header
 * value — or, for the probe, request body — fails to coerce), so its own
 * `String`/`Symbol.toPrimitive` can throw; run inside a catch function that
 * would **defect** the frame and bypass the `string` channel. Here the throw is
 * a defect of its own `Effect.sync`, recovered to the fixed fallback, so this
 * always succeeds.
 */
const describeCause = (cause: unknown): Effect.Effect<string> =>
	Effect.sync(() => String(cause)).pipe(
		Effect.catchCause(() => Effect.succeed("an unprintable cause")),
	);

/**
 * Call one plugin-supplied protocol member, turning a throw into the `string`
 * error channel (spec §9's isolation, at the seam a plugin actually reaches).
 * `registerProvider` validates only `send`, so `headers` and `buildRequest` are
 * untyped plugin code at this boundary: a throw there would **defect** the
 * helper, and a caller's typed `catch` would miss it — which is how
 * "Test connection" and "Fetch models" reset silently. `Effect.try`, not a
 * native `try`/`catch`, keeps the call in Effect, and `describeCause` keeps the
 * message itself from throwing.
 */
const pluginCall = <A>(
	protocol: string,
	what: string,
	call: () => A,
): Effect.Effect<A, string> =>
	Effect.gen(function* () {
		const outcome = yield* Effect.try({
			try: call,
			// A typed cell, not the raw `unknown`: the cause is plugin code and
			// is described by `describeCause`, never surfaced as the error type.
			catch: (cause) => ({ cause }),
		}).pipe(Effect.result);
		if (Result.isFailure(outcome)) {
			const detail = yield* describeCause(outcome.failure.cause);
			return yield* Effect.fail(
				`the "${protocol}" protocol could not ${what}: ${detail}`,
			);
		}
		return outcome.success;
	});

/**
 * `fetch` whose rejection is described without `String` throwing. The request's
 * `headers` are plugin-supplied (and so is the probe's body), so the rejection
 * reason can be a value whose own stringification throws — `Effect.tryPromise`'s
 * `catch` would then throw out of its own frame and defect the caller.
 */
const fetchDescribed = (
	call: () => Promise<Response>,
): Effect.Effect<Response, string> =>
	Effect.tryPromise({
		try: call,
		catch: (cause) => ({ cause }),
	}).pipe(
		Effect.catch((carrier) =>
			describeCause(carrier.cause).pipe(
				Effect.flatMap((detail) => Effect.fail(detail)),
			),
		),
	);

/**
 * `GET ${baseUrl}/models` — the OpenAI list endpoint (`baseUrl` carries the
 * version, so no `/v1` here). Auth comes from the endpoint itself, so an
 * Anthropic provider sends `x-api-key` rather than a Bearer token. A
 * non-2xx response, a transport failure, or a throw from the plugin-supplied
 * `headers` becomes the `string` error channel.
 */
export const listModels = (
	protocol: string,
	baseUrl: string,
	apiKey: string | undefined,
): Effect.Effect<string[], string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		const headers = yield* pluginCall(
			protocol,
			"build its request headers",
			(): Record<string, string> => ({
				accept: "application/json",
				...provider.headers(apiKey),
			}),
		);

		const response = yield* fetchDescribed(() =>
			fetch(`${baseUrl}/models`, { headers }),
		);

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
 * response, a transport failure, or a throw from a plugin-supplied member
 * (`headers`, `buildRequest`) becomes the `string` error channel.
 */
export const testModel = (
	protocol: string,
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
): Effect.Effect<void, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		// Both members the probe calls are plugin code; each throw is isolated
		// into the `string` channel rather than escaping as a defect.
		const headers = yield* pluginCall(
			protocol,
			"build its request headers",
			() => provider.headers(apiKey),
		);

		const probe = yield* pluginCall(protocol, "build a test request", () =>
			provider.buildRequest(provider.template, {
				msg: "ping",
				prev: provider.template,
				apiUrl: baseUrl,
				apiKey,
				model,
				fetchTool: false,
			} satisfies SendCtx),
		);

		const response = yield* fetchDescribed(() =>
			fetch(`${baseUrl}${provider.endpoint}`, {
				method: "POST",
				headers,
				body: JSON.stringify(probe),
			}),
		);

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

/** The line a successful probe reports. */
const probeSucceeded = (model: string): string => `✓ ${model} responded`;

/**
 * Reduce a probe's whole cause to the one line to show. A typed failure already
 * carries a readable message (a non-2xx status, or an isolated member throw).
 * The fallback is a **totality** requirement, not a coverage target:
 * `catchCause` also catches a **defect or an interrupt**, neither of which has
 * an error option, and `probeConnection`'s signature is `Effect<string, never>`
 * so it cannot re-raise. No plugin-reachable state reaches it — every
 * plugin-supplied member sits inside `pluginCall` or `fetchDescribed`, so a
 * plugin throw is always typed — but the line keeps the button from resetting
 * with nothing to read if one ever does.
 */
const probeFailure = (protocol: string, cause: Cause.Cause<string>): string =>
	Option.getOrElse(
		Cause.findErrorOption(cause),
		() =>
			`the "${protocol}" protocol could not be reached: ${Cause.pretty(cause)}`,
	);

/**
 * Probe `model` on `protocol` and return the one line to display: a success
 * tick, or a readable failure. **Never fails** — the probe's typed failure
 * *and* any defect are caught here, which is what the Settings "Test
 * connection" button needs: its typed `Effect.catch` saw failures only, so a
 * plugin protocol whose `headers` threw made the button silently reset (the
 * defect escaped the catch and only `ensuring` ran). Isolating at the source
 * keeps the message in one place no UI caller has to remember to catch.
 */
export const probeConnection = (
	protocol: string,
	baseUrl: string,
	apiKey: string | undefined,
	model: string,
): Effect.Effect<string, never, HostServices> =>
	testModel(protocol, baseUrl, apiKey, model).pipe(
		Effect.as(probeSucceeded(model)),
		Effect.catchCause((cause) => Effect.succeed(probeFailure(protocol, cause))),
	);
