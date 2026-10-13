import { PluginFault } from "@lib/plugins/errors";
import type { HostServices } from "@lib/plugins/host";
import { type AnyProvider, requireProvider } from "@lib/plugins/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { Cause, Effect, Stream } from "effect";

/**
 * Send one turn on the protocol called `protocol` (spec §5), resolving it
 * through the registry via the shared `requireProvider` seam. A name no
 * built-in or plugin provides is a failed turn with a readable sentence —
 * never a `TypeError` on an absent provider, which is what a static lookup
 * produced once the name could come from a plugin.
 *
 * **A plugin protocol is host-called plugin code, so both halves of it are
 * isolated (spec §3/§9).** {@link sendThrough} isolates the `send` *call*: a
 * throw or a failed effect becomes a logged `PluginFault` and a failed turn.
 * {@link isolateStream} isolates the **stream `send` returns**, because the
 * loop runs that stream later, outside this function — a stream that dies
 * (`Stream.die`) would otherwise defect the turn and reach `finalize` as an
 * anonymous "request failed", with nothing logged. Both turn such a fault into
 * a logged `PluginFault` and a `string` failure, the same graceful path every
 * other turn failure takes. Interruption is re-raised in both, so a stopped
 * turn stays a stop.
 *
 * `HostServices` is required because the protocol is runtime data: the caller
 * runs this on the subsystem's runtime, where the registries live.
 *
 * A fault names **both** the protocol and the plugin that registered it
 * (`provider.owner`): with a name that can come from anywhere, the protocol
 * alone does not say which plugin misbehaved — the same attribution the tool
 * and pipeline seams already carry.
 */

/** The one sentence a faulted protocol is reported with. */
const faultSentence = (protocol: string, cause: Cause.Cause<unknown>): string =>
	`the protocol "${protocol}" faulted: ${Cause.pretty(cause)}`;

/** Log a `PluginFault` naming the protocol and its plugin, then fail with the sentence. */
const faultAndFail = (
	protocol: string,
	pluginId: string,
	cause: Cause.Cause<unknown>,
): Effect.Effect<never, string> =>
	Effect.andThen(
		Effect.logWarning(
			new PluginFault({
				detail: faultSentence(protocol, cause),
				pluginId,
			}),
		),
		Effect.fail(faultSentence(protocol, cause)),
	);

/**
 * Isolate the stream a protocol returned (spec §9). The loop runs this stream
 * after `send` has returned, so a defect raised while it is consumed would
 * otherwise escape {@link sendThrough}'s isolation entirely. A typed failure
 * (the protocol's own `string` channel — a non-2xx response, say) and an
 * interruption are re-raised untouched; a defect becomes a logged `PluginFault`
 * and a `string` failure.
 */
const isolateStream = (
	protocol: string,
	pluginId: string,
	stream: Stream.Stream<Chunk, string>,
): Stream.Stream<Chunk, string> =>
	stream.pipe(
		Stream.catchCause((cause) =>
			Cause.hasFails(cause) || Cause.hasInterrupts(cause)
				? Stream.failCause(cause)
				: Stream.fromEffect(faultAndFail(protocol, pluginId, cause)),
		),
	);

/**
 * Invoke a resolved protocol's `send`, isolating a throw from the call and any
 * defect in the stream it returns. An interruption is re-raised, never turned
 * into a failed turn.
 */
const sendThrough = (
	protocol: string,
	pluginId: string,
	provider: AnyProvider,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string> =>
	Effect.suspend(() => provider.send(ctx)).pipe(
		Effect.map((stream) => isolateStream(protocol, pluginId, stream)),
		Effect.catchCause((cause) =>
			Cause.hasInterrupts(cause)
				? Effect.failCause(cause)
				: faultAndFail(protocol, pluginId, cause),
		),
	);

export const SendMsg = (
	protocol: string,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk, string>, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* requireProvider(protocol);
		return yield* sendThrough(protocol, provider.owner, provider, ctx);
	});
