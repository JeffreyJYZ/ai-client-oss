import { describe, expect, test } from "bun:test";

import { PREFLIGHT_REFUSAL } from "@lib/providers/presets";
import {
	type ChatIpc,
	type ChatRequest,
	type ChatResponse,
	chatTransport,
	chooseTransport,
	nativeTransport,
	nativeTransportWith,
	type StreamMessage,
	webTransport,
} from "@lib/providers/transport";
import { Cause, Effect, Exit, Option, Stream } from "effect";

/**
 * The transport the app reaches for, and the desktop transport's own rules: the
 * status before the body, the body in order, one terminal message, and a cancel
 * that reaches the shell. The shell commands themselves are proven separately
 * (the Rust unit tests, and the browser proof through the committed desktop
 * stub).
 */

const OPENCODE_URL = "https://opencode.ai/inference/openai/v1/chat/completions";

const realFetch = globalThis.fetch;

/** The `string` a failed effect carries, or `""` when it succeeded. */
const failureOf = async (
	effect: Effect.Effect<unknown, string>,
): Promise<string> => {
	const exit = await Effect.runPromise(Effect.exit(effect));
	return Exit.isFailure(exit)
		? Option.getOrElse(Cause.findErrorOption(exit.cause), () => "")
		: "";
};

interface Scripted {
	readonly ipc: ChatIpc;
	readonly started: ChatRequest[];
	readonly cancelled: string[];
}

/**
 * A scripted shell: it relays `messages` to the channel in order, then settles
 * — or rejects, which is what the real command does when the request failed
 * before it had a status to relay.
 */
const scripted = (
	messages: readonly StreamMessage[],
	options: { readonly reject?: string } = {},
): Scripted => {
	const started: ChatRequest[] = [];
	const cancelled: string[] = [];
	return {
		started,
		cancelled,
		ipc: {
			start: (request, onMessage) => {
				started.push(request);
				if (options.reject !== undefined) return Promise.reject(options.reject);
				for (const message of messages) onMessage(message);
				return Promise.resolve();
			},
			cancel: (requestId) => {
				cancelled.push(requestId);
				return Promise.resolve();
			},
		},
	};
};

/** The body a stream carries, concatenated in order. */
const bodyOf = (
	stream: Stream.Stream<string, string>,
): Effect.Effect<string, string> =>
	Stream.runFold(
		stream,
		() => "",
		(all, text) => all + text,
	);

describe("the transport a build uses", () => {
	test("the shell on the desktop, the app's own fetch otherwise", () => {
		expect(chooseTransport(true)).toBe(nativeTransport);
		expect(chooseTransport(false)).toBe(webTransport);
	});

	test("a stored token routes through the companion, read per call", async () => {
		// Install a companion token in a localStorage stand-in.
		const map = new Map<string, string>();
		map.set("ai-client.companion", JSON.stringify({ token: "tok-1" }));
		(globalThis as { localStorage?: Storage }).localStorage = {
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => map.set(key, value),
			removeItem: (key: string) => map.delete(key),
			clear: () => map.clear(),
			key: () => null,
			get length() {
				return map.size;
			},
		} as unknown as Storage;
		globalThis.fetch = ((url: string) => {
			if (url === "http://127.0.0.1:47821/v1/chat") {
				return Promise.resolve(new Response("ok", { status: 200 }));
			}
			return Promise.resolve(new Response("web", { status: 200 }));
		}) as unknown as typeof fetch;
		const response = await Effect.runPromise(
			chatTransport("https://example.com/v1/chat/completions", {}, "{}"),
		);
		expect(response.status).toBe(200);
		await Effect.runPromise(response.text);
		globalThis.fetch = realFetch;
	});
});

describe("the desktop transport", () => {
	/** One relayed response for a scripted shell, to be consumed once. */
	const relay = async (
		messages: readonly StreamMessage[],
	): Promise<ChatResponse> => {
		const { ipc } = scripted(messages);
		return Effect.runPromise(
			nativeTransportWith(ipc)(
				OPENCODE_URL,
				{ "x-opencode-session": "conv-1" },
				"{}",
			),
		);
	};

	test("relays the status, then the body in order, and feeds the same lines", async () => {
		const script: readonly StreamMessage[] = [
			{ type: "status", status: 200 },
			{
				type: "chunk",
				text: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DO',
			},
			{ type: "chunk", text: "NE]\n\n" },
			{ type: "end" },
		];

		// A response's body is read once, by whichever reader its status chose.
		const response = await relay(script);
		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);

		// The split of the body across two relayed messages is invisible: the
		// concatenation is the wire's own bytes, in order, so the shared line
		// parser sees exactly what the web path would have seen.
		expect(await Effect.runPromise(bodyOf(response.chunks))).toBe(
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
		);

		const again = await relay(script);
		const lines = await Effect.runPromise(
			Stream.runCollect(again.chunks.pipe(Stream.splitLines)),
		);
		expect([...lines].filter((line) => line !== "")).toEqual([
			'data: {"choices":[{"delta":{"content":"hi"}}]}',
			"data: [DONE]",
		]);
	});

	test("hands the shell the URL, the assembled headers and the body", async () => {
		const { ipc, started } = scripted([
			{ type: "status", status: 200 },
			{ type: "end" },
		]);
		await Effect.runPromise(
			nativeTransportWith(ipc)(
				OPENCODE_URL,
				{ "x-opencode-session": "conv-1" },
				'{"model":"m"}',
			),
		);
		expect(started).toHaveLength(1);
		expect(started[0].url).toBe(OPENCODE_URL);
		expect(started[0].headers).toEqual({ "x-opencode-session": "conv-1" });
		expect(started[0].body).toBe('{"model":"m"}');
	});

	test("a non-2xx carries its body as the caller's detail", async () => {
		const { ipc } = scripted([
			{ type: "status", status: 404 },
			{ type: "chunk", text: '{"error":"no such model"}' },
			{ type: "end" },
		]);
		const response = await Effect.runPromise(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		expect(response.status).toBe(404);
		expect(response.ok).toBe(false);
		expect(await Effect.runPromise(response.text)).toBe(
			'{"error":"no such model"}',
		);
	});

	test("a request that failed before its status fails outright, not silently", async () => {
		const { ipc, started, cancelled } = scripted([], {
			reject: "failed to send POST https://opencode.ai/…",
		});
		const failure = await failureOf(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		expect(failure).toContain("failed to send POST");
		// Nothing can be streamed, so the shell's request is not left running.
		expect(cancelled).toEqual([started[0].requestId]);
	});

	test("a first message that is not a status fails and aborts the request", async () => {
		const { ipc, started, cancelled } = scripted([
			{ type: "chunk", text: "data: one\n\n" },
		]);
		const failure = await failureOf(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		expect(failure).toContain("sent no status");
		expect(cancelled).toEqual([started[0].requestId]);
	});

	test("body runs that arrive after the command settles are all relayed", async () => {
		// The command's settlement is independent of the channel's delivery
		// order. A terminal offered when it resolves is processed before these
		// runs — the microtask runs before the next task — and would end the
		// body early, dropping them with the caller unable to tell a complete
		// body from a truncated one. The shell sends its own terminal; nothing
		// else may end the body.
		const early: readonly StreamMessage[] = [
			{ type: "status", status: 200 },
			{ type: "chunk", text: "data: one\n\n" },
		];
		const late: readonly StreamMessage[] = [
			{ type: "chunk", text: "data: two\n\n" },
			{ type: "end" },
		];
		const ipc: ChatIpc = {
			start: (_request, onMessage) => {
				for (const message of early) onMessage(message);
				return new Promise((resolve) => {
					setTimeout(() => {
						// The command settles first; the rest of the body is
						// delivered on a later task, as the shell's channel
						// evaluations land.
						resolve();
						setTimeout(() => {
							for (const message of late) onMessage(message);
						}, 0);
					}, 0);
				});
			},
			cancel: () => Promise.resolve(),
		};

		const response = await Effect.runPromise(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		expect(await Effect.runPromise(bodyOf(response.chunks))).toBe(
			"data: one\n\ndata: two\n\n",
		);
	});

	test("a body with no terminal message stays open, not silently complete", async () => {
		// The shell relays exactly one terminal on every path it can return
		// from, so it does not produce this; if it did, the body must not read
		// as finished — an unanswered body is not a complete one.
		const { ipc } = scripted([
			{ type: "status", status: 200 },
			{ type: "chunk", text: "data: one\n\n" },
		]);
		const response = await Effect.runPromise(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		const ended = await Effect.runPromise(
			Effect.timeoutOption(bodyOf(response.chunks), "150 millis"),
		);
		expect(Option.isNone(ended)).toBe(true);
	});

	test("a failure after the status fails the body stream", async () => {
		const { ipc } = scripted([
			{ type: "status", status: 200 },
			{ type: "chunk", text: "data: one\n\n" },
			{ type: "error", message: "failed to read response from the endpoint" },
		]);
		const response = await Effect.runPromise(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		expect(response.ok).toBe(true);
		expect(await failureOf(bodyOf(response.chunks))).toBe(
			"failed to read response from the endpoint",
		);
	});

	test("cancelling a response aborts the shell's own request", async () => {
		const { ipc, started, cancelled } = scripted([
			{ type: "status", status: 200 },
			{ type: "chunk", text: "data: one\n\n" },
		]);
		const response = await Effect.runPromise(
			nativeTransportWith(ipc)(OPENCODE_URL, {}, "{}"),
		);
		await Effect.runPromise(response.cancel);
		expect(cancelled).toEqual([started[0].requestId]);
	});
});

describe("the web transport", () => {
	test("is the app's own fetch, with the same status and detail", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response('{"error":"bad"}', { status: 400 }),
			)) as unknown as typeof fetch;
		const response = await Effect.runPromise(
			webTransport("https://openrouter.ai/api/v1/chat/completions", {}, "{}"),
		);
		expect(response.status).toBe(400);
		expect(response.ok).toBe(false);
		expect(await Effect.runPromise(response.text)).toBe('{"error":"bad"}');
		// Nothing to abort: the browser's own request ends with the response.
		await Effect.runPromise(response.cancel);
		globalThis.fetch = realFetch;
	});

	test("an ok response with no body is refused, as it always was", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(null, { status: 204 }),
			)) as unknown as typeof fetch;
		const failure = await failureOf(
			webTransport("https://openrouter.ai/api/v1/chat/completions", {}, "{}"),
		);
		expect(failure).toBe("response has no body");
		globalThis.fetch = realFetch;
	});

	test("an unprintable rejection lands in the typed channel, not as a defect", async () => {
		// A plugin supplies the request's headers, so the rejection reason can be
		// a value whose own `String`/`Symbol.toPrimitive` throws. Describing it
		// *inside* the catch function would throw out of that frame and defect
		// the effect — a failure no typed `catch` upstream can see, which is the
		// silent reset the `string` channel exists to prevent.
		const unprintable = {
			toString: () => {
				throw new Error("no string for you");
			},
			[Symbol.toPrimitive]: () => {
				throw new Error("no primitive either");
			},
		};

		for (const url of [
			"https://openrouter.ai/api/v1/chat/completions",
			OPENCODE_URL,
		]) {
			globalThis.fetch = (() =>
				Promise.reject(unprintable)) as unknown as typeof fetch;
			const exit = await Effect.runPromise(
				Effect.exit(webTransport(url, {}, "{}")),
			);
			expect(Exit.isFailure(exit), url).toBe(true);
			// The typed channel, not a defect: `findErrorOption` is empty for a
			// defect, which is what these sentinels assert against.
			const described = Exit.isFailure(exit)
				? Option.getOrElse(Cause.findErrorOption(exit.cause), () => "a defect")
				: "no failure";
			expect(described, url).toBe(
				url === OPENCODE_URL ? PREFLIGHT_REFUSAL : "an unprintable cause",
			);
		}
		globalThis.fetch = realFetch;
	});
});
