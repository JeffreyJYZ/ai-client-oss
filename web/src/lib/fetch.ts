import { isDesktop } from "@lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";

/**
 * Upper bound on the text handed to the model for one page: a
 * long article still fits whole, while one enormous page cannot
 * eat the conversation's context.
 */
export const MAX_CHARS: number = 50_000;

/** Appended after a capped page so the model can tell it saw a slice. */
const TRUNCATED_NOTE = `\n[page text truncated at ${MAX_CHARS} characters]`;

/** Apply the character cap, noting the truncation so the model can tell. */
const capped = (text: string): string =>
	text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS) + TRUNCATED_NOTE;

/**
 * Render HTML as the plain text a page is trying to say. The
 * platform parser is the standard tool: it decodes entities
 * (the ones that matter here — amp, lt, gt, quot, numeric
 * refs and nbsp — and every other one) and tolerates malformed
 * markup, so the output is honest rather than a regex guess.
 * Pure: it parses into a throwaway document and touches no
 * global state.
 *
 * A client-rendered page has nothing in its body, so the head's own
 * title and description are read before the head is dropped and
 * returned on their own, labelled: the model must know it is reading
 * metadata rather than the page, or it will report a page it never saw.
 */
export const htmlToText = (html: string): string => {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const title = doc.title.trim();
	const description =
		doc
			.querySelector('meta[name="description"]')
			?.getAttribute("content")
			?.trim() ?? "";
	// Not prose: a script's source, a style's rules and the head's
	// metadata would otherwise read as if the author had written them.
	doc.querySelectorAll("script, style, head").forEach((element) => {
		element.remove();
	});
	const parts: string[] = [];
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node !== null) {
		// A space before each text node keeps element boundaries from
		// gluing words together; runs of whitespace collapse below,
		// so the separation costs nothing.
		parts.push(` ${node.nodeValue ?? ""}`);
		node = walker.nextNode();
	}
	const text = parts.join("").replace(/\s+/g, " ").trim();
	if (text !== "") return capped(text);
	const metadata = [title, description]
		.filter((part) => part !== "")
		.join("\n");
	if (metadata === "") return "";
	return capped(
		`Only this page's metadata was readable (its content is rendered by scripts):\n${metadata}`,
	);
};

/**
 * Desktop transport: the Rust shell reads the URL outside the
 * browser, so no cross-origin rule applies. `invoke` rejects
 * with a string; the wrap keeps that rejection inside the
 * Effect and states it as a sentence.
 */
const fetchDesktop = (url: string): Effect.Effect<string, string> =>
	Effect.tryPromise({
		try: () => invoke<string>("fetch_url", { url }),
		catch: (cause) => `Could not fetch the page: ${String(cause)}`,
	});

/**
 * Web transport. A cross-origin refusal surfaces as a TypeError
 * in the browser; say which wall was hit and point at the desktop
 * app, which reads the page directly, instead of leaking the raw
 * exception.
 */
const fetchWeb = (url: string): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () => fetch(url),
			catch: (cause) =>
				cause instanceof TypeError
					? "This site refused a cross-origin read — the browser will not let a web page fetch another origin. The desktop app fetches it directly."
					: `Could not fetch the page: ${String(cause)}`,
		});
		// An error page's markup is not the page's text: say what
		// happened instead of handing the model the 404's body.
		if (!response.ok) {
			return yield* Effect.fail(
				`The site answered with HTTP status ${response.status}.`,
			);
		}
		return yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) => `Could not read the page body: ${String(cause)}`,
		});
	});

/**
 * Read a URL as plain text for the model: the desktop transport
 * inside the Tauri shell, the browser's own fetch elsewhere. The
 * result is the page run through `htmlToText` and capped at
 * `MAX_CHARS`; every failure is a sentence a user can read in a
 * chat bubble.
 *
 * Nothing readable is a failure, never an empty success: an empty
 * tool result left the model to invent the reason for it — it
 * blamed the deployment and the user agent — so the app says what
 * happened instead.
 */
export const fetchUrlText = (url: string): Effect.Effect<string, string> =>
	Effect.flatMap(isDesktop ? fetchDesktop(url) : fetchWeb(url), (html) => {
		const text = htmlToText(html);
		return text === ""
			? Effect.fail(
					`The page at ${url} returned no readable text. It is probably rendered entirely by scripts, which this client does not run.`,
				)
			: Effect.succeed(text);
	});
