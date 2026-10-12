import { fetchUrlText } from "@lib/fetch";
import type {
	Tool,
	ToolDeclaration,
	ToolExecCtx,
	ToolOutcome,
} from "@lib/plugins/tools";
import { FETCH_URL_NAME, fetchUrlTool } from "@lib/providers/presets";
import { Effect } from "effect";

/**
 * The built-in `fetch_url` tool (spec §5), registered through the same public
 * API a plugin uses. The executor is the body that used to sit in
 * `state/chat.ts` as `runFetch`, unchanged: the same argument reading, the same
 * failure sentences, the same marker — every user-visible string is pinned by
 * `tools.test.ts`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** The transcript marker for a failed fetch. */
const fetchFailedMarker = (sentence: string): string =>
	`🔗 fetch failed: ${sentence}`;

/**
 * Execute one `fetch_url` call: fetch the URL's page as text and render both
 * outcomes as strings — a missing or non-string `url` is a failed result (a
 * sentence, no fetch attempted), never an exception out of the loop. The fetch
 * runs inside the calling fiber, so `stop` interrupts a fetch in flight.
 */
const execute = (
	input: unknown,
	ctx: ToolExecCtx,
): Effect.Effect<ToolOutcome> =>
	Effect.gen(function* () {
		const url = isRecord(input) ? input.url : undefined;
		if (typeof url !== "string" || url.trim() === "") {
			const sentence = `${FETCH_URL_NAME} was called without a URL.`;
			return {
				result: sentence,
				marker: fetchFailedMarker(sentence),
				failed: true,
				input,
			};
		}
		// The fetch's failure channel is the sentence the transcript
		// shows; either way the outcome is a string for the model.
		const outcome = yield* Effect.catch(
			Effect.map(fetchUrlText(url, ctx.tinyfishApiKey), (page) => ({
				ok: true as const,
				page,
			})),
			(sentence) => Effect.succeed({ ok: false as const, sentence }),
		);
		if (!outcome.ok) {
			return {
				result: outcome.sentence,
				marker: fetchFailedMarker(outcome.sentence),
				failed: true,
				input,
			};
		}
		const host = yield* Effect.orElseSucceed(
			Effect.try({
				try: () => new URL(url).host,
				catch: () => "not a URL",
			}),
			() => url,
		);
		return {
			result: outcome.page,
			marker: `🔗 fetched ${host} (${outcome.page.length.toLocaleString()} chars)`,
			failed: false,
			input,
		};
	});

/**
 * The flat (Responses) envelope `presets.ts` builds for this tool. The
 * declaration is read from it rather than re-typed here, so the description the
 * model is handed and the parameter schema a request actually declares cannot
 * drift apart.
 */
const wire = fetchUrlTool("responses") as {
	readonly description: string;
	readonly parameters: Record<string, unknown>;
};

const declaration: ToolDeclaration = {
	name: FETCH_URL_NAME,
	description: wire.description,
	parameters: wire.parameters,
};

export const fetchUrlBuiltin: Tool = { declaration, execute };
