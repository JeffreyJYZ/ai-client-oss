import { PluginFault } from "@lib/plugins/errors";
import type { HostServices } from "@lib/plugins/host";
import { type AnyProvider, requireProvider } from "@lib/plugins/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Cause, Effect, type Stream } from "effect";

/**
 * Send one turn on the protocol called `protocol` (spec §5), resolving it
 * through the registry via the shared `requireProvider` seam. A name no
 * built-in or plugin provides is a failed turn with a readable sentence —
 * never a `TypeError` on an absent provider, which is what a static lookup
 * produced once the name could come from a plugin.
 *
 * The call into the protocol is failure-isolated (spec §9): a plugin protocol
 * whose `send` throws, or whose stream defects, is a logged `PluginFault` and a
 * failed turn — not a crashed chat loop. An interruption is re-raised, so a
 * stopped turn stays a stop.
 *
 * `HostServices` is required because the protocol is runtime data: the caller
 * runs this on the subsystem's runtime, where the registries live.
 */

/** Invoke a resolved protocol's `send`, isolating a throw or a defected stream. */
const sendThrough = (
	protocol: string,
	provider: AnyProvider,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
	Effect.suspend(() => provider.send(ctx)).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterrupts(cause)
				? Effect.failCause(cause)
				: Effect.andThen(
						Effect.logWarning(
							new PluginFault({
								detail: `the protocol "${protocol}" faulted: ${Cause.pretty(cause)}`,
							}),
						),
						Effect.fail(
							`the protocol "${protocol}" faulted: ${Cause.pretty(cause)}`,
						),
					),
		),
	);

export const SendMsg = (
	protocol: string,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		return yield* sendThrough(protocol, provider, ctx);
	});
