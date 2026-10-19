import type { ProviderConfig, Settings } from "@lib/db/types";
import type { ProviderEntry } from "@lib/plugins/providers";
import { isOpencodeHost } from "@lib/providers/presets";
import { Effect, Stream } from "effect";

/**
 * The longest title the sidebar keeps. A free model asked for a few words
 * sometimes answers with a paragraph; the cap is applied **after** the
 * decoration is stripped, so the cut never leaves a dangling `**` behind.
 */
export const TITLER_MAX_TITLE_LENGTH = 60;

/**
 * The word bound the prompt states. Private: it is a sentence the model reads,
 * not a value any caller acts on, and `cleanTitle`'s character cap is the one
 * that actually guards the sidebar.
 */
const TITLER_MAX_TITLE_WORDS = 6;

/**
 * What the titler's single request carries: ask for a title and nothing else.
 * Small free models otherwise answer with a sentence, a quoted title or both
 * (`cleanTitle` is the backstop, not the plan).
 */
export const TITLER_PROMPT = `Name the conversation from the user's message. Reply with a title and nothing else: at most ${TITLER_MAX_TITLE_WORDS} words, no quotes, no markdown, no trailing punctuation, no "Title:" label.`;

/**
 * The free lane of an OpenCode host. Documented free for a limited time
 * (https://opencode.ai/docs/zen/), which is exactly why the cached model list
 * is consulted before it is trusted — the id moves, the rule does not.
 */
const OPENCODE_FREE_MODEL = "step-5-preview-free";

/**
 * OpenRouter's free-models router (https://openrouter.ai/openrouter/free): it
 * picks a free model per request and never bills, so the fallback stays a free
 * one without the app carrying a price table.
 */
const OPENROUTER_FREE_MODEL = "openrouter/free";

/**
 * True for an OpenRouter host. Local to this module because nothing else needs
 * the read; `searchKindFor` answers a *search* question and would tie model
 * identity to the search mechanism.
 */
const isOpenrouterHost = (baseUrl: string): boolean =>
	baseUrl.toLowerCase().includes("openrouter.ai");

/** A provider is usable only with a key: none is an honest no-op, never a 401. */
const hasKey = (provider: ProviderConfig): boolean =>
	provider.apiKey.trim() !== "";

/**
 * The free id a lane may use, or `undefined` when the provider's own cached
 * list disproves it. An **empty** list means the user never fetched models, so
 * there is nothing to contradict the hardcoded choice; a list that no longer
 * carries it means the id retired — the lane degrades instead of sending a
 * request that cannot succeed, and never falls through to a paid call.
 */
const freeModelFor = (
	provider: ProviderConfig,
	candidate: string,
): string | undefined =>
	provider.models.length === 0 || provider.models.includes(candidate)
		? candidate
		: undefined;

/**
 * Which provider and model the titler should use, or `undefined` for "stay
 * off". Pure, so the rule is testable without a runtime, and total: every case
 * ends in a free id or in nothing.
 *
 * Order (the spec's, exactly): an explicit `Settings.titler` override wins;
 * then an **OpenCode** provider that has a key **and is on a platform that can
 * call it** — its chat endpoint refuses a browser's CORS preflight, so on web
 * this lane is unreachable and skipping it is what keeps the titler honest
 * instead of surfacing `TypeError: Load failed`; then an **OpenRouter**
 * provider with a key; else off.
 *
 * A provider with no key counts as unresolved, not as a request that fails.
 */
export const resolveTitlerModel = (
	settings: Pick<Settings, "providers" | "titler">,
	isDesktop: boolean,
): { providerId: string; model: string } | undefined => {
	const override = settings.titler;
	if (override?.providerId != null && override.model != null) {
		if (override.providerId.trim() !== "" && override.model.trim() !== "") {
			return { providerId: override.providerId, model: override.model };
		}
	}

	const opencode = isDesktop
		? settings.providers.find(
				(provider) => hasKey(provider) && isOpencodeHost(provider.baseUrl),
			)
		: undefined;
	if (opencode !== undefined) {
		const model = freeModelFor(opencode, OPENCODE_FREE_MODEL);
		if (model !== undefined) return { providerId: opencode.id, model };
	}

	const openrouter = settings.providers.find(
		(provider) => hasKey(provider) && isOpenrouterHost(provider.baseUrl),
	);
	if (openrouter !== undefined) {
		const model = freeModelFor(openrouter, OPENROUTER_FREE_MODEL);
		if (model !== undefined) return { providerId: openrouter.id, model };
	}

	return undefined;
};

/** Quote pairs a small model wraps its answer in, ASCII and typographic. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
	['"', '"'],
	["'", "'"],
	["\u201C", "\u201D"],
	["\u2018", "\u2019"],
	["\u00AB", "\u00BB"],
];

/** Markdown emphasis and code markers, longest first so `**` peels as one. */
const EMPHASIS_MARKERS = ["**", "__", "~~", "*", "_", "`"] as const;

/**
 * Peel exactly one layer of decoration: a matching quote pair, or one
 * emphasis/code marker on each end. `undefined` when there is nothing to peel,
 * so the caller can stop.
 */
const peelOnce = (text: string): string | undefined => {
	for (const [open, close] of QUOTE_PAIRS) {
		if (
			text.length > open.length &&
			text.startsWith(open) &&
			text.endsWith(close)
		) {
			return text.slice(open.length, text.length - close.length);
		}
	}
	for (const marker of EMPHASIS_MARKERS) {
		if (
			text.length > marker.length * 2 &&
			text.startsWith(marker) &&
			text.endsWith(marker)
		) {
			return text.slice(marker.length, text.length - marker.length);
		}
	}
	return undefined;
};

/** Strip a leading markdown heading marker, then peel decoration to a fixpoint. */
const stripDecoration = (raw: string): string => {
	let text = raw.replace(/^#{1,6}\s+/, "").trim();
	let previous = "";
	while (previous !== text) {
		previous = text;
		text = peelOnce(text)?.trim() ?? text;
	}
	return text;
};

/**
 * Turn whatever a small free model replied with into a title worth showing:
 * drop a leading `Title:` label, flatten to one line, peel wrapping quotes and
 * markdown emphasis (repeatedly, so `"**X**"` becomes `X`), then cap the
 * length. Pure and total — an empty or decoration-only reply cleans to `""`,
 * which the caller reads as "no title".
 *
 * **The order is the contract:** stripping happens *before* the cap, or a
 * title that is exactly at the bound would have its closing marker cut and
 * keep a stray `**`.
 */
export const cleanTitle = (raw: string): string => {
	const unlabeled = raw.replace(/^\s*title\s*[:：]\s*/i, "");
	const oneLine = unlabeled.replace(/\s+/g, " ").trim();
	return stripDecoration(oneLine).slice(0, TITLER_MAX_TITLE_LENGTH);
};

/**
 * One title request, through the **provider's own** `send` — the same member
 * the chat path and `testModel` call — so the transport (the native shell on
 * desktop, the webview's `fetch` on web), the endpoint's headers and the body
 * builder are the ones already proven, and a test can hold the `ctx` a real
 * request would send.
 *
 * The effect requires **nothing** (`R = never`): the provider *and* its
 * credentials arrive as values, so this needs no `HostServices` and runs on the
 * empty-context runtime the area's `host.run` supplies (see the spec's "How it
 * runs"). Its failure is a typed `string` cause for the caller to log — a
 * surface that cannot answer is *resolved-but-failing*, which the caller
 * distinguishes from "nothing to do".
 *
 * The request carries the titler's own message (`TITLER_PROMPT` plus the first
 * message), `fetchTool: false`, no `tools` and no `search` (a title needs no
 * round trip), and **the conversation's own id** as the session — an endpoint
 * that routes or caches per conversation (`x-opencode-session`) must not
 * attribute this conversation's request to the probe's constant id.
 *
 * Only `kind === "text"` chunks are folded: a reasoning model streams its
 * scratchpad first, and folding that would put the model's thinking in the
 * sidebar. The fold is sanitized by {@link cleanTitle}; a reply that carries no
 * text — or nothing left after the decoration is peeled — returns `undefined`,
 * because an empty title is worse than the derived one.
 */
export const titleFor = (input: {
	provider: ProviderEntry;
	baseUrl: string;
	apiKey: string;
	model: string;
	conversationId: string;
	firstMessage: string;
}): Effect.Effect<string | undefined, string> =>
	Effect.gen(function* () {
		const stream = yield* input.provider.send({
			msg: `${TITLER_PROMPT}\n\n${input.firstMessage}`,
			// Nothing is replayed: this request starts from the provider's own
			// template exactly as the first round of a fresh turn does.
			prev: input.provider.template,
			apiUrl: input.baseUrl,
			apiKey: input.apiKey,
			model: input.model,
			// The conversation this request belongs to, so an endpoint that
			// needs a per-conversation session header gets this one's id.
			conversationId: input.conversationId,
			// No tools, no search: a tool round has no caller here, and the
			// answer is one line.
			fetchTool: false,
		});

		const reply = yield* stream.pipe(
			Stream.filter((chunk) => chunk.kind === "text"),
			Stream.map((chunk) => chunk.text),
			Stream.mkString,
		);

		const title = cleanTitle(reply);
		return title === "" ? undefined : title;
	});
