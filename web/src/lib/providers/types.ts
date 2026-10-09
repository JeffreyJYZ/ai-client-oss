import type { Effect, Stream } from "effect";
import type { z } from "zod";

export interface Chunk {
	readonly text: string;
}

export interface SendCtx {
	readonly msg: string;
	readonly prev: unknown;
	readonly apiUrl: string;
	readonly apiKey?: string;
}

export interface Provider<Send> {
	readonly schema: z.ZodType<Send>;
	readonly endpoint: string;
	readonly template: Send;
	parse(raw: unknown): Effect.Effect<Send, string>;
	buildRequest(send: Send, ctx: SendCtx): unknown;
	send(ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk, string>, string>;
}
