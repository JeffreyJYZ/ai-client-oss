import { PluginFault } from "@lib/plugins/errors";
import { HostServices } from "@lib/plugins/host";
import type { RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import type {
	Chunk,
	HistoryTurn,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { Cause, Effect, Option, Ref } from "effect";

/**
 * The pipeline registry (spec §5): ordered middleware around a model request
 * and its streamed reply. A **stage** is one middleware function plus the kind
 * it answers to; the six kinds and their contracts are the table in spec §5.
 *
 * Stages live in the host's own `pipeline` registry (`HostServices`), the same
 * collection every other contribution uses, so a stage registered by a plugin
 * is owned and disposed by that plugin's `Scope`. Only this module reads them
 * as stages, which is what makes the narrowing in {@link isStageEntry} sound.
 *
 * **Fail-open is the whole safety story** (spec §9): a stage that faults —
 * failing, throwing or dying — is logged, disabled for the session, and
 * skipped, and the request continues with that stage's input unchanged. A
 * pipeline that can fail a turn is worse than no pipeline.
 */

/** The six stages, in the order spec §5's table lists them. */
export type PipelineStageKind =
	| "beforeSend"
	| "transformBody"
	| "onChunk"
	| "afterReply"
	| "onToolCall"
	| "onHistory";

/**
 * The turn a stage is running in: what names it to a plugin that keys its own
 * state per conversation or per protocol. The stage's own value rides as the
 * first argument, not here.
 */
export interface PipelineMeta {
	readonly conversationId: string;
	readonly protocol: string;
}

/** `onToolCall`'s answer: veto the call, and/or rewrite it (spec §5). */
export interface ToolCallDecision {
	readonly allow: boolean;
	readonly rewrite?: ToolCallData;
}

/** What each stage receives: one entry per kind, so `run` stays typed. */
export interface PipelineInputMap {
	readonly beforeSend: SendCtx;
	readonly transformBody: unknown;
	readonly onChunk: Chunk;
	readonly afterReply: string;
	readonly onToolCall: ToolCallData;
	readonly onHistory: readonly HistoryTurn[];
}

/**
 * What each stage returns. `Option.none()` in `beforeSend` aborts the turn;
 * in `onChunk` it drops that one chunk (the stream still terminates).
 */
export interface PipelineOutputMap {
	readonly beforeSend: Option.Option<SendCtx>;
	readonly transformBody: unknown;
	readonly onChunk: Option.Option<Chunk>;
	readonly afterReply: string;
	readonly onToolCall: ToolCallDecision;
	readonly onHistory: readonly HistoryTurn[];
}

/**
 * One stage contract per kind (spec §5). The error channel is `never`: a
 * contract is success-only, and a stage that misbehaves is caught and skipped
 * by {@link guard} rather than surfacing as a failure.
 */
export type PipelineStageMap = {
	readonly [K in PipelineStageKind]: (
		input: PipelineInputMap[K],
		meta: PipelineMeta,
	) => Effect.Effect<PipelineOutputMap[K]>;
};

/** A plugin's contribution to one stage kind (spec §5). */
export interface PipelineStage<
	K extends PipelineStageKind = PipelineStageKind,
> {
	readonly kind: K;
	readonly run: PipelineStageMap[K];
}

/**
 * The entry a stage is stored as: `RegistryEntry`'s identity, ownership and
 * sort keys plus the stage's kind and function.
 */
export interface PipelineEntry extends RegistryEntry {
	readonly kind: PipelineStageKind;
	readonly run: PipelineStageMap[PipelineStageKind];
}

/**
 * Ids of stages disabled for this session, in one module-level `Ref` (spec
 * §9). `Ref.make` is a pure `Effect.sync`, so it runs at module scope with no
 * runtime and no boot-order dependency — unlike the registry bridges, which
 * need `HostServices` and therefore must wait for `main.tsx`'s boot await.
 */
const disabled = Effect.runSync(Ref.make<ReadonlySet<string>>(new Set()));

/**
 * Narrow a raw registry entry to a stage of `kind`. Defensive because the
 * `pipeline` registry is generic: until the typed surface lands, a plugin can
 * register anything, so an entry without a matching `kind` and a callable
 * `run` is ignored rather than dereferenced.
 */
const isStageEntry = (
	entry: RegistryEntry,
	kind: PipelineStageKind,
): entry is PipelineEntry => {
	const candidate = entry as { kind?: unknown; run?: unknown };
	return candidate.kind === kind && typeof candidate.run === "function";
};

/**
 * Run one stage's effect, fail-open (spec §9). A fault the kind channel cannot
 * carry — a thrown error, a defect, a failing effect from untyped plugin code —
 * is logged as a `PluginFault`, the stage's id is recorded, and `fallback` (the
 * input unchanged) is returned. An interrupt is re-raised untouched: a stage
 * that was interrupted because the turn was stopped must not be mistaken for a
 * fault, or `stop` would disable it.
 *
 * `Effect.suspend` is load-bearing: `stage()` may throw synchronously, before
 * any effect exists, so the call has to be deferred into the runtime for the
 * catch to see it.
 */
const guard = <A>(
	entry: PipelineEntry,
	stage: () => Effect.Effect<A>,
	fallback: A,
): Effect.Effect<A> =>
	Effect.catchCause(
		Effect.suspend(stage),
		(cause): Effect.Effect<A> =>
			Cause.hasInterrupts(cause)
				? Effect.failCause(cause)
				: Effect.gen(function* () {
						yield* Ref.update(disabled, (set) => new Set([...set, entry.id]));
						yield* Effect.logWarning(
							new PluginFault({
								detail: `pipeline stage "${entry.id}" (${entry.kind}) faulted and was disabled for the session: ${Cause.pretty(cause)}`,
								pluginId: entry.owner,
							}),
						);
						return fallback;
					}),
	);

const foldBeforeSend = (
	stages: readonly PipelineEntry[],
	input: SendCtx,
	meta: PipelineMeta,
): Effect.Effect<Option.Option<SendCtx>> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["beforeSend"];
			const next = yield* guard(
				entry,
				() => stage(current, meta),
				Option.some(current),
			);
			if (Option.isNone(next)) return Option.none<SendCtx>();
			current = next.value;
		}
		return Option.some(current);
	});

const foldTransformBody = (
	stages: readonly PipelineEntry[],
	input: unknown,
	meta: PipelineMeta,
): Effect.Effect<unknown> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["transformBody"];
			current = yield* guard(entry, () => stage(current, meta), current);
		}
		return current;
	});

const foldOnChunk = (
	stages: readonly PipelineEntry[],
	input: Chunk,
	meta: PipelineMeta,
): Effect.Effect<Option.Option<Chunk>> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["onChunk"];
			const next = yield* guard(
				entry,
				() => stage(current, meta),
				Option.some(current),
			);
			if (Option.isNone(next)) return Option.none<Chunk>();
			current = next.value;
		}
		return Option.some(current);
	});

const foldAfterReply = (
	stages: readonly PipelineEntry[],
	input: string,
	meta: PipelineMeta,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["afterReply"];
			current = yield* guard(entry, () => stage(current, meta), current);
		}
		return current;
	});

const foldOnToolCall = (
	stages: readonly PipelineEntry[],
	input: ToolCallData,
	meta: PipelineMeta,
): Effect.Effect<ToolCallDecision> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["onToolCall"];
			const decision = yield* guard(entry, () => stage(current, meta), {
				allow: true,
			});
			if (!decision.allow) return { allow: false };
			if (decision.rewrite !== undefined) {
				// Correlation is the model's: the rewritten call keeps the
				// original id/key so its result matches the `tool_call` already
				// on the wire, whatever a stage names the rewrite.
				current = { ...decision.rewrite, id: input.id, key: input.key };
			}
		}
		return current === input
			? { allow: true }
			: { allow: true, rewrite: current };
	});

const foldOnHistory = (
	stages: readonly PipelineEntry[],
	input: readonly HistoryTurn[],
	meta: PipelineMeta,
): Effect.Effect<readonly HistoryTurn[]> =>
	Effect.gen(function* () {
		let current = input;
		for (const entry of stages) {
			const stage = entry.run as PipelineStageMap["onHistory"];
			current = yield* guard(entry, () => stage(current, meta), current);
		}
		return current;
	});

/**
 * The stages of one kind, in the pipeline's own resolution order: `priority`
 * descending, then registration order (a stable sort preserves the registry's
 * insertion order for equal priorities). The sort is applied here rather than
 * taken from the registry's `entries()` because the registry's generic rule
 * compares `order` first, and with no entry setting `order` it computes
 * `Infinity - Infinity = NaN` and falls straight through to registration
 * order — so `priority` would never break a tie. The pipeline names only
 * `priority`, so it owns that one comparison.
 */
const stagesOf = (
	entries: readonly RegistryEntry[],
	kind: PipelineStageKind,
	off: ReadonlySet<string>,
): readonly PipelineEntry[] =>
	entries
		.filter(
			(entry): entry is PipelineEntry =>
				isStageEntry(entry, kind) && !off.has(entry.id),
		)
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

/**
 * Run every stage of `kind` over `input`, in resolution order. Reads the
 * registry each call, so a stage registered or disposed mid-session takes
 * effect on the next turn, and skips any stage disabled by an earlier fault.
 */
export const run = <K extends PipelineStageKind>(
	kind: K,
	input: PipelineInputMap[K],
	meta: PipelineMeta,
): Effect.Effect<PipelineOutputMap[K], never, HostServices> =>
	Effect.gen(function* () {
		const services = yield* HostServices;
		const off = yield* Ref.get(disabled);
		const stages = stagesOf(yield* services.pipeline.entries(), kind, off);
		const dispatch: {
			readonly [P in PipelineStageKind]: () => Effect.Effect<
				PipelineOutputMap[P]
			>;
		} = {
			beforeSend: () => foldBeforeSend(stages, input as SendCtx, meta),
			transformBody: () => foldTransformBody(stages, input, meta),
			onChunk: () => foldOnChunk(stages, input as Chunk, meta),
			afterReply: () => foldAfterReply(stages, input as string, meta),
			onToolCall: () => foldOnToolCall(stages, input as ToolCallData, meta),
			onHistory: () =>
				foldOnHistory(stages, input as readonly HistoryTurn[], meta),
		};
		return yield* dispatch[kind]();
	});

/**
 * {@link run} read synchronously off the app's one runtime. `state/chat.ts`'s
 * `send` builds the request body it forks with, so `beforeSend`,
 * `transformBody` (the first round's body) and `onHistory` are read here
 * rather than pushed into an Effect that would change when the optimistic rows
 * appear. The runtime's layer is built before the first render (`main.tsx`
 * awaits `runtime.runPromise`), so the context is cached and this has no async
 * boundary.
 *
 * A mid-`Effect.gen` caller must use {@link run} instead: `runSync` inside a
 * generator trips the Effect language service, and the body the tool loop
 * builds belongs in that generator.
 */
export const runSync = <K extends PipelineStageKind>(
	kind: K,
	input: PipelineInputMap[K],
	meta: PipelineMeta,
): PipelineOutputMap[K] => runtime.runSync(run(kind, input, meta));

/**
 * Project an `onToolCall` decision onto the call the loop acts on (spec §5).
 * A declined call is still returned — never dropped — so the loop always
 * appends a matching result and the replayed body carries no `tool_call`
 * without one. A rewrite keeps the original `id`/`key` for that correlation.
 */
export interface ResolvedToolCall {
	readonly call: ToolCallData;
	readonly execute: boolean;
}

export const resolveToolCall = (
	call: ToolCallData,
	decision: ToolCallDecision,
): ResolvedToolCall =>
	decision.allow
		? {
				call:
					decision.rewrite === undefined
						? call
						: { ...decision.rewrite, id: call.id, key: call.key },
				execute: true,
			}
		: { call, execute: false };
