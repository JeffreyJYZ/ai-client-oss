import { isDesktop } from "@lib/platform";
import { capText, MAX_CHARS } from "@lib/text";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * TinyFish's Search and Fetch APIs — the client-side web search
 * and page-read backend for users with an API key. Both take the
 * key as an argument: a `lib/` module never reads settings.
 */

/** The public Search API endpoint. */
export const TINYFISH_SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
/** The public Fetch API endpoint. */
export const TINYFISH_FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
/** The header both APIs authenticate with. */
export const TINYFISH_API_KEY_HEADER = "X-API-Key";
/** Where the user creates a key. */
export const TINYFISH_API_KEYS_URL = "https://agent.tinyfish.ai/api-keys";

/**
 * One ranked search result, trimmed to what the model needs: the
 * title, the URL and the snippet.
 */
export interface SearchHit {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

/** Separator between hits in the formatted results. */
const HIT_SEPARATOR = "\n\n";

/** Appended after a capped page so the model can tell it saw a slice. */
const PAGE_TRUNCATED_NOTE = `\n[page text truncated at ${MAX_CHARS} characters]`;

const authHeaders = (apiKey: string): Record<string, string> => ({
	[TINYFISH_API_KEY_HEADER]: apiKey,
});

/** The Search API request URL for one query. */
const searchRequestUrl = (query: string): string =>
	`${TINYFISH_SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}`;

/**
 * The hits a Search API response carries, or `null` when the body
 * is not the shape the endpoint documents (no `results` array).
 * Entries without a title or URL are skipped — a hit the model
 * cannot cite is not a result. Pure.
 */
export const searchHits = (parsed: unknown): readonly SearchHit[] | null => {
	const results =
		typeof parsed === "object" && parsed !== null
			? (parsed as { results?: unknown }).results
			: undefined;
	if (!Array.isArray(results)) return null;
	const hits: SearchHit[] = [];
	for (const result of results) {
		if (typeof result !== "object" || result === null) continue;
		const { title, url, snippet } = result as {
			readonly title?: unknown;
			readonly url?: unknown;
			readonly snippet?: unknown;
		};
		if (typeof title !== "string" || typeof url !== "string") continue;
		hits.push({
			title,
			url,
			snippet: typeof snippet === "string" ? snippet : "",
		});
	}
	return hits;
};

/**
 * The compact text the model reads: a header naming the query, then
 * one numbered entry per result — a title, a URL and a snippet —
 * capped at `MAX_CHARS` so a wide search cannot eat the
 * conversation's context. Pure.
 */
export const formatSearchResults = (
	query: string,
	hits: readonly SearchHit[],
): string => {
	const rendered = hits.map((hit, index) => {
		const lines = [`${index + 1}. ${hit.title}`, `   ${hit.url}`];
		if (hit.snippet !== "") lines.push(`   ${hit.snippet}`);
		return lines.join("\n");
	});
	const text = `Search results for "${query}":\n\n${rendered.join(HIT_SEPARATOR)}`;
	return capText(
		text,
		`\n[search results truncated at ${MAX_CHARS} characters]`,
	);
};

/**
 * The number of hits a formatted search response carries. The text
 * is this module's own format — the header block, then one block
 * per hit — so the count is structural, not a guess. Pure.
 */
export const searchResultCount = (text: string): number =>
	Math.max(text.split(HIT_SEPARATOR).length - 1, 0);

/**
 * Parse a response body as JSON. A non-JSON body (an error page, a
 * plain-text 401) is a failure sentence, never a raw exception.
 */
const parseJsonBody = (raw: string): Effect.Effect<unknown, string> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: () => "TinyFish answered with a body that is not JSON.",
	});

/**
 * Desktop transport: the Rust shell sends the request outside the
 * browser, so no cross-origin rule applies and the API key rides
 * the `X-API-Key` header. `invoke` rejects with a string; the wrap
 * keeps that rejection inside the Effect and states it as a
 * sentence.
 */
const requestDesktop = (
	method: "GET" | "POST",
	url: string,
	apiKey: string,
	body?: string,
): Effect.Effect<string, string> =>
	Effect.tryPromise({
		try: () =>
			invoke<string>("http_request", {
				method,
				url,
				headers: authHeaders(apiKey),
				...(body === undefined ? {} : { body }),
			}),
		catch: (cause) => `Could not reach TinyFish: ${String(cause)}`,
	});

/**
 * Web transport. A cross-origin refusal surfaces as a TypeError in
 * the browser; say which wall was hit — the same sentence a page
 * fetch uses — instead of leaking the raw exception.
 */
const requestWeb = (
	method: "GET" | "POST",
	url: string,
	apiKey: string,
	body?: string,
): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(url, {
					method,
					headers: {
						...authHeaders(apiKey),
						"content-type": "application/json",
					},
					body,
				}),
			catch: (cause) =>
				cause instanceof TypeError
					? "This site refused a cross-origin read — the browser will not let a web page fetch another origin. The desktop app fetches it directly."
					: `Could not reach TinyFish: ${String(cause)}`,
		});
		// An error page's markup is not the API's answer: say what
		// happened instead of handing the model the 401's body.
		if (!response.ok) {
			return yield* Effect.fail(
				`TinyFish answered with HTTP status ${response.status}.`,
			);
		}
		return yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) =>
				`Could not read the TinyFish response: ${String(cause)}`,
		});
	});

const tinyfishRequest = (
	method: "GET" | "POST",
	url: string,
	apiKey: string,
	body?: string,
): Effect.Effect<string, string> =>
	isDesktop
		? requestDesktop(method, url, apiKey, body)
		: requestWeb(method, url, apiKey, body);

/**
 * Search the web through the TinyFish Search API and return the
 * results as compact text for the model. An empty or malformed
 * response is a failure, never an empty success — an empty tool
 * result left the model to invent the reason for it.
 */
export const searchWeb = (
	query: string,
	apiKey: string,
): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const raw = yield* tinyfishRequest("GET", searchRequestUrl(query), apiKey);
		const parsed = yield* parseJsonBody(raw);
		const hits = searchHits(parsed);
		if (hits === null || hits.length === 0) {
			return yield* Effect.fail("The search returned no results.");
		}
		return yield* Effect.succeed(formatSearchResults(query, hits));
	});

/** The page text a read produced, or the sentence for its failure. */
interface PageOutcome {
	readonly ok: boolean;
	readonly text: string;
	readonly sentence: string;
}

/**
 * The page text a Fetch API response carries for the URL it was
 * asked to read, or the sentence for why it carries none. Per-URL
 * failures (timeouts, DNS errors, anti-bot blocks) arrive in
 * `errors[]` beside a `200`, so the response itself reports them.
 * Pure.
 */
const pageOutcome = (parsed: unknown, url: string): PageOutcome => {
	if (typeof parsed !== "object" || parsed === null) {
		return {
			ok: false,
			text: "",
			sentence: "TinyFish answered with an unexpected response.",
		};
	}
	const { results, errors } = parsed as {
		readonly results?: unknown;
		readonly errors?: unknown;
	};
	if (Array.isArray(results)) {
		const first = results[0];
		if (typeof first === "object" && first !== null) {
			const { text } = first as { readonly text?: unknown };
			if (typeof text === "string" && text !== "") {
				return { ok: true, text, sentence: "" };
			}
		}
	}
	if (Array.isArray(errors) && errors.length > 0) {
		const first = errors[0];
		const reason =
			typeof first === "object" && first !== null
				? (first as { readonly error?: unknown }).error
				: undefined;
		return {
			ok: false,
			text: "",
			sentence: `Could not fetch the page: ${
				typeof reason === "string" ? reason : "the fetch failed"
			}`,
		};
	}
	return {
		ok: false,
		text: "",
		sentence: `The page at ${url} returned no readable text.`,
	};
};

/**
 * Fetch a URL as text through the TinyFish Fetch API, whose servers
 * render JavaScript-heavy pages a browser cannot. The result is
 * capped at `MAX_CHARS`; every failure is a sentence a user can
 * read in a chat bubble.
 */
export const fetchPage = (
	url: string,
	apiKey: string,
): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const raw = yield* tinyfishRequest(
			"POST",
			TINYFISH_FETCH_ENDPOINT,
			apiKey,
			JSON.stringify({ urls: [url] }),
		);
		const parsed = yield* parseJsonBody(raw);
		const outcome = pageOutcome(parsed, url);
		if (!outcome.ok) {
			return yield* Effect.fail(outcome.sentence);
		}
		return yield* Effect.succeed(capText(outcome.text, PAGE_TRUNCATED_NOTE));
	});
