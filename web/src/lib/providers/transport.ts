import { isDesktop } from "@lib/platform";
import {
	PREFLIGHT_REFUSAL,
	refusesBrowserPreflight,
} from "@lib/providers/presets";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Effect, Queue, Stream } from "effect";

/**
 * One message from the desktop shell's streaming command, in the order the
 * shell sent it. The shell's own enum has exactly these four variants: `status`
 * first always, then the body as `chunk` runs, then `end` for a body relayed
 * whole or `error` for one that could not be.
 */
export type StreamMessage =
	| { readonly type: "status"; readonly status: number }
	| { readonly type: "chunk"; readonly text: string }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "end" };

/** Everything one streaming request needs, apart from its message sink. */
export interface ChatRequest {
	readonly requestId: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

/**
 * The shell's side of the desktop transport: start one streaming request, and
 * abort one. A seam rather than a direct `invoke` call, so the transport's own
 * rules — the status gate, the terminal message, the cancel — are exercised by
 * a unit test; {@link tauriChatIpc} is the production wiring, and the browser
 * proof (`scripts/desktop-stub.js`) drives that wiring end to end.
 */
export interface ChatIpc {
	/** Resolves when the request's body has been relayed (or failed). */
	start(
		request: ChatRequest,
		onMessage: (message: StreamMessage) => void,
	): Promise<void>;
	/** Aborts an in-flight request; an unknown id is a no-op. */
	cancel(requestId: string): Promise<void>;
}

export const CHAT_STREAM_COMMAND = "chat_stream";
export const CHAT_STREAM_CANCEL_COMMAND = "chat_stream_cancel";

/**
 * The shell command's `Channel`, whose own message ordering (each message
 * carries an index) keeps the relayed sequence exactly the sequence the shell
 * sent. The handler is set before the channel is passed, because a message that
 * arrives before a handler is not replayed.
 */
const channelFor = (
	onMessage: (message: StreamMessage) => void,
): Channel<StreamMessage> => {
	const channel = new Channel<StreamMessage>();
	channel.onmessage = onMessage;
	return channel;
};

/** The real shell commands (see `chat_stream` in `web/src-tauri/src/lib.rs`). */
export const tauriChatIpc: ChatIpc = {
	start: (request, onMessage) =>
		invoke<void>(CHAT_STREAM_COMMAND, {
			requestId: request.requestId,
			url: request.url,
			headers: request.headers,
			body: request.body,
			onEvent: channelFor(onMessage),
		}),
	cancel: (requestId) =>
		invoke<void>(CHAT_STREAM_CANCEL_COMMAND, { requestId }),
};

/**
 * One chat request's response, as the two things the caller needs of it: the
 * status, and the body. `text` is the whole body (the non-2xx detail);
 * `chunks` is the body as it arrives (the SSE lines). Only one of the two is
 * ever consumed — a non-2xx has no stream to parse — so one request feeds one
 * body reader.
 */
export interface ChatResponse {
	readonly status: number;
	readonly ok: boolean;
	readonly text: Effect.Effect<string, string>;
	readonly chunks: Stream.Stream<string, string>;
	/** Releases an open request when the caller stops consuming it. */
	readonly cancel: Effect.Effect<void>;
}

export type ChatTransport = (
	url: string,
	headers: Record<string, string>,
	body: string,
) => Effect.Effect<ChatResponse, string>;

/**
 * How a refused web request is described. A browser refuses a cross-origin POST
 * before it is sent and reports `TypeError: Load failed` with nothing else to
 * go on. For an endpoint known to refuse the preflight, say what happened and
 * where it does work instead of echoing WebKit; every other endpoint keeps the
 * description it always had.
 */
const webFailure = (url: string, cause: unknown): string =>
	refusesBrowserPreflight(url) ? PREFLIGHT_REFUSAL : String(cause);

/**
 * The browser's own path: the request this app always made — `fetch` with the
 * endpoint's headers, the response's `text()` as the non-2xx detail, and its
 * body decoded as it arrives. Byte-for-byte the previous behaviour, because the
 * web build must not change: the desktop transport is the only new thing here.
 */
export const webTransport: ChatTransport = (url, headers, body) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () => fetch(url, { method: "POST", headers, body }),
			catch: (cause) => webFailure(url, cause),
		});

		const raw = response.body;
		// The previous code refused an ok response with no body outright, rather
		// than handing the parser an empty stream.
		if (response.ok && raw === null)
			return yield* Effect.fail("response has no body");

		return {
			status: response.status,
			ok: response.ok,
			text: Effect.tryPromise({
				try: () => response.text(),
				catch: () => "",
			}),
			// A non-2xx needs no body stream at all, and a bodyless response has
			// none to give.
			chunks:
				raw === null
					? Stream.empty
					: Stream.fromReadableStream<Uint8Array, string>({
							evaluate: () => raw,
							onError: (cause) => String(cause),
						}).pipe(Stream.decodeText()),
			cancel: Effect.void,
		};
	});

/**
 * The desktop path: the shell makes the request, outside the webview's
 * cross-origin rules, and relays the response back through a `Channel`.
 *
 * The status is the first message, so the caller learns it before any of the
 * body is read — which is also what proves nothing is buffered. Everything
 * after the status is one ordered stream, terminated by the shell's own `end`
 * (or `error`); the command's settlement is a **backstop** terminal, offered
 * into the same mailbox, so a request that failed before it sent a status, or
 * an IPC failure, can never leave the caller waiting on a message that will
 * never come.
 */
export const nativeTransportWith =
	(ipc: ChatIpc): ChatTransport =>
	(url, headers, body) =>
		Effect.gen(function* () {
			const requestId = crypto.randomUUID();
			const mailbox = yield* Queue.unbounded<StreamMessage>();
			yield* Effect.sync(() => {
				ipc
					.start({ requestId, url, headers, body }, (message) => {
						Queue.offerUnsafe(mailbox, message);
					})
					.then(
						() => {
							Queue.offerUnsafe(mailbox, { type: "end" });
						},
						(cause) => {
							Queue.offerUnsafe(mailbox, {
								type: "error",
								message: String(cause),
							});
						},
					);
			});

			const first = yield* Queue.take(mailbox);
			if (first.type === "error") return yield* Effect.fail(first.message);
			if (first.type !== "status")
				return yield* Effect.fail(
					`the streaming request sent no status (${first.type})`,
				);
			const status = first.status;

			// The body runs, in the order the shell relayed them, up to the
			// terminal message. A `status` after the first carries nothing.
			const chunks = Stream.fromQueue(mailbox).pipe(
				Stream.takeWhile((message) => message.type !== "end"),
				Stream.mapEffect(
					(message): Effect.Effect<string, string> =>
						message.type === "error"
							? Effect.fail(message.message)
							: Effect.succeed(message.type === "chunk" ? message.text : ""),
				),
			);

			return {
				status,
				ok: status >= 200 && status < 300,
				text: Stream.runFold(
					chunks,
					() => "",
					(all, text) => all + text,
				).pipe(Effect.orElseSucceed(() => "")),
				chunks,
				// Called when the caller stops consuming `chunks` (a stopped
				// turn), not when the request finishes: the shell's request is
				// aborted, so an abandoned stream does not stay open.
				cancel: Effect.ignore(
					Effect.tryPromise({
						try: () => ipc.cancel(requestId),
						catch: () => "cancel failed",
					}),
				),
			};
		});

/** The desktop transport, over the real shell commands. */
export const nativeTransport: ChatTransport = nativeTransportWith(tauriChatIpc);

/** The transport a build uses, from the platform it runs on. */
export const chooseTransport = (desktop: boolean): ChatTransport =>
	desktop ? nativeTransport : webTransport;

/**
 * The transport this build uses. `isDesktop` is a module-level read of
 * `__TAURI_INTERNALS__`, so the choice is fixed for the session; this is
 * {@link chooseTransport} applied to it, so a test asserts the same rule.
 */
export const chatTransport: ChatTransport = chooseTransport(isDesktop);
