import { type ProtocolName, providers } from "@lib/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import type { Effect, Stream } from "effect";

export const SendMsg = (
	protocol: ProtocolName,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk>, string> => providers[protocol].send(ctx);
