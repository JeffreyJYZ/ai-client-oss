import type { Host, PipelineEntry, PipelineMeta } from "@lib/plugins/sdk";
import type { HistoryTurn, SendCtx } from "@lib/providers/types";
import { Effect, Option } from "effect";

/**
 * history-pipeline — the three pipeline stages that are hardest to picture
 * (spec §5).
 *
 * What it teaches:
 * - **`onHistory`**: trims the conversation history to the most recent
 *   `KEEP_TURNS` turns before a request is built;
 * - **`beforeSend`**: aborts the whole turn with `Option.none()` when the
 *   prompt is empty after trimming, so an empty submission never reaches the
 *   model;
 * - **`afterReply`**: records one stat line through `host.log` once the reply
 *   has streamed.
 *
 * Fail-open contract (spec §9): a stage that faults — fails, throws or dies —
 * is logged, disabled for the session, and skipped, and the request continues
 * with that stage's input unchanged. A pipeline that could fail a turn would be
 * worse than no pipeline, so every stage here is written to return its input
 * unchanged on the path it does not handle, and none of them throws.
 *
 * What it deliberately does not do: it does not transform the request body
 * (`transformBody`), drop chunks (`onChunk`), veto tool calls (`onToolCall` —
 * see `custom-tool`), or register a provider. N is a single constant, not a
 * setting.
 */
/** How many of the most recent turns survive `onHistory`. */
export const KEEP_TURNS = 4;

/** Pure: keep only the most recent `KEEP_TURNS` turns. */
export const trimHistory = (
	turns: readonly HistoryTurn[],
): readonly HistoryTurn[] => {
	if (turns.length <= KEEP_TURNS) return turns;
	return turns.slice(turns.length - KEEP_TURNS);
};

/** Pure: whether a send context carries an empty prompt after trimming. */
export const isEmptyPrompt = (ctx: SendCtx): boolean => ctx.msg.trim() === "";

export default {
	setup(host: Host) {
		host.log.info(
			`history-pipeline loaded; onHistory keeps the last ${KEEP_TURNS} turns`,
		);

		const onHistoryStage: Omit<PipelineEntry, "owner"> = {
			id: "example.history-pipeline.on-history",
			kind: "onHistory",
			run: (turns: readonly HistoryTurn[], _meta: PipelineMeta) =>
				Effect.succeed(trimHistory(turns)),
		};

		const beforeSendStage: Omit<PipelineEntry, "owner"> = {
			id: "example.history-pipeline.before-send",
			kind: "beforeSend",
			run: (ctx: SendCtx, _meta: PipelineMeta) => {
				if (isEmptyPrompt(ctx)) {
					host.log.warn(
						"history-pipeline: empty prompt after trimming; aborting the turn",
					);
					return Effect.succeed(Option.none<SendCtx>());
				}
				return Effect.succeed(Option.some(ctx));
			},
		};

		const afterReplyStage: Omit<PipelineEntry, "owner"> = {
			id: "example.history-pipeline.after-reply",
			kind: "afterReply",
			run: (reply: string, _meta: PipelineMeta) =>
				Effect.sync(() => {
					host.log.info(`history-pipeline: reply ${reply.length} chars`);
					return reply;
				}),
		};

		host.pipeline.register(onHistoryStage);
		host.pipeline.register(beforeSendStage);
		host.pipeline.register(afterReplyStage);

		host.log.info(
			"history-pipeline loaded; registered onHistory, beforeSend and afterReply stages",
		);
	},
};
