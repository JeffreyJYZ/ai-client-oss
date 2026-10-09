import { afterEach, expect, test } from "bun:test";
import { providers } from "@lib/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Effect, Stream } from "effect";

const ctx = (over: Partial<SendCtx> = {}): SendCtx => ({
	msg: "hi",
	prev: undefined,
	apiUrl: "http://test",
	...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const collectText = (stream: Stream.Stream<Chunk>): Promise<string[]> =>
	Effect.runPromise(
		Stream.runCollect(stream).pipe(
			Effect.map((chunks) => chunks.map((chunk) => chunk.text)),
		),
	);

test("maps SSE data lines to text chunks, skipping [DONE] and blanks", async () => {
	globalThis.fetch = (async () =>
		new Response('data: {"delta":"a"}\n\ndata: [DONE]\n\n', {
			status: 200,
		})) as unknown as typeof fetch;

	const chunks = await Effect.runPromise(providers.responses.send(ctx()));
	expect(await collectText(chunks)).toEqual(["a"]);
});

test("fails with a string on a non-2xx response", async () => {
	globalThis.fetch = (async () =>
		new Response("nope", { status: 500 })) as unknown as typeof fetch;

	const exit = await Effect.runPromiseExit(providers.responses.send(ctx()));
	expect(exit._tag).toBe("Failure");
});

test("builds a request without an auth header when apiKey is absent", async () => {
	let seen: Headers | undefined;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		seen = new Headers(init?.headers);
		return new Response("data: [DONE]\n\n");
	}) as unknown as typeof fetch;

	await Effect.runPromise(providers.responses.send(ctx()));
	expect(seen?.has("authorization")).toBe(false);
});

test("sends a bearer token when apiKey is set", async () => {
	let seen: Headers | undefined;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		seen = new Headers(init?.headers);
		return new Response("data: [DONE]\n\n");
	}) as unknown as typeof fetch;

	await Effect.runPromise(providers.responses.send(ctx({ apiKey: "secret" })));
	expect(seen?.get("authorization")).toBe("Bearer secret");
});

test("skips a malformed data line instead of failing the stream", async () => {
	globalThis.fetch = (async () =>
		new Response('data: {not json\n\ndata: {"delta":"ok"}\n\n', {
			status: 200,
		})) as unknown as typeof fetch;

	const chunks = await Effect.runPromise(providers.responses.send(ctx()));
	expect(await collectText(chunks)).toEqual(["ok"]);
});
