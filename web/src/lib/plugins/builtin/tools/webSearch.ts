import type {
	Tool,
	ToolDeclaration,
	ToolExecCtx,
	ToolOutcome,
} from "@lib/plugins/tools";
import { WEB_SEARCH_NAME, webSearchTool } from "@lib/providers/presets";
import { searchResultCount, searchWeb } from "@lib/tinyfish";
import { Effect } from "effect";

/**
 * The built-in client-side `web_search` tool (spec §5), registered through the
 * same public API a plugin uses. The executor is the body that used to sit in
 * `state/chat.ts` as `runSearch`, unchanged: the same argument reading, the same
 * failure sentences, the same markers — pinned by `tools.test.ts`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** The transcript marker for a failed search. */
const searchFailedMarker = (sentence: string): string =>
	`🔍 search failed: ${sentence}`;

/**
 * Execute one `web_search` call: search through TinyFish and render both
 * outcomes as strings — a missing or non-string `query` is a failed result (a
 * sentence, no search attempted), never an exception out of the loop. The
 * search runs inside the calling fiber, so `stop` interrupts it.
 */
const execute = (
	input: unknown,
	ctx: ToolExecCtx,
): Effect.Effect<ToolOutcome> =>
	Effect.gen(function* () {
		const query = isRecord(input) ? input.query : undefined;
		if (typeof query !== "string" || query.trim() === "") {
			const sentence = `${WEB_SEARCH_NAME} was called without a query.`;
			return {
				result: sentence,
				marker: searchFailedMarker(sentence),
				failed: true,
				input,
			};
		}
		// The search's failure channel is the sentence the
		// transcript shows; either way the outcome is a string
		// for the model.
		const outcome = yield* Effect.catch(
			Effect.map(searchWeb(query.trim(), ctx.tinyfishApiKey ?? ""), (text) => ({
				ok: true as const,
				text,
			})),
			(sentence) => Effect.succeed({ ok: false as const, sentence }),
		);
		if (!outcome.ok) {
			return {
				result: outcome.sentence,
				marker: searchFailedMarker(outcome.sentence),
				failed: true,
				input,
			};
		}
		// The count is structural — the compact text is
		// one blank-line-separated block per hit — so the
		// marker can say how many results came back.
		const count = searchResultCount(outcome.text);
		return {
			result: outcome.text,
			marker: `🔍 searched the web: ${count.toLocaleString()} result${
				count === 1 ? "" : "s"
			}`,
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
const wire = webSearchTool("responses") as {
	readonly description: string;
	readonly parameters: Record<string, unknown>;
};

const declaration: ToolDeclaration = {
	name: WEB_SEARCH_NAME,
	description: wire.description,
	parameters: wire.parameters,
};

export const webSearchBuiltin: Tool = { declaration, execute };
