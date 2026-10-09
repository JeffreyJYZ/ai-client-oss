import { type ProtocolName, providers } from "@lib/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Effect, type Stream } from "effect";

export const SendMsg = (
	protocol: ProtocolName,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string> => {
	const provider: (typeof providers)[ProtocolName] | undefined =
		providers[protocol];
	if (provider === undefined) {
		return Effect.fail(`unknown protocol: ${protocol}`);
	}
	return provider.send(ctx);
};
