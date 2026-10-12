import type { HostServices } from "@lib/plugins/host";
import { resolveProvider } from "@lib/plugins/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Effect, Option, type Stream } from "effect";

/**
 * Send one turn on the protocol called `protocol` (spec §5), resolving it
 * through the registry. A name no built-in or plugin provides is a failed turn
 * with a readable sentence — never a `TypeError` on an absent provider, which
 * is what a static lookup produced once the name could come from a plugin.
 *
 * `HostServices` is required because the protocol is runtime data: the caller
 * runs this on the subsystem's runtime, where the registries live.
 */
export const SendMsg = (
	protocol: string,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* resolveProvider(protocol);
		if (Option.isNone(provider)) {
			return yield* Effect.fail(`unknown protocol: ${protocol}`);
		}
		return yield* provider.value.send(ctx);
	});
