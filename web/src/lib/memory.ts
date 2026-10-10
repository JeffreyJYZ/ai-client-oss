import type { MemoryNote } from "@lib/db/types";

/**
 * Tag pair the model wraps memory blocks in, inside its own reply text. The
 * app runs no tool-calling loop, so the blocks are inline markers stripped
 * before the text is displayed or stored — identical on every protocol.
 */
export const MEMORY_TAG_OPEN = "<memory>";
export const MEMORY_TAG_CLOSE = "</memory>";

/** Caps so a chatty model cannot grow the injected prompt without bound. */
export const MAX_MEMORY_NOTES = 50;
export const MAX_MEMORY_NOTE_LENGTH = 200;

/** One complete block; the lazy quantifier keeps two blocks from merging. */
const BLOCK = new RegExp(
	`${MEMORY_TAG_OPEN}([\\s\\S]*?)${MEMORY_TAG_CLOSE}`,
	"g",
);

export interface ExtractedMemories {
	/** Reply text with every complete block (and any partial tag) removed. */
	readonly text: string;
	/** Trimmed block contents, in order; whitespace-only blocks dropped. */
	readonly memories: readonly string[];
}

const nextMemoryId = (): string => `memory-${crypto.randomUUID()}`;

/** Normalise one block's content: collapse newlines to spaces, then trim. */
const normalize = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/**
 * Longest suffix of `text` that is a still-arriving prefix of the open tag
 * (`<m`, `<me`, ... up to `<memory`). Returns 0 when there is none, so
 * ordinary text ending in `<` or `<p` is never clipped. A bare `<` alone
 * (length 1) is deliberately left alone: prose like "5 < 6" is far more
 * likely than a tag that streams one character at a time.
 */
const partialTagSuffix = (text: string): number => {
	for (
		let length = Math.min(text.length, MEMORY_TAG_OPEN.length - 1);
		length >= 2;
		length--
	) {
		if (MEMORY_TAG_OPEN.startsWith(text.slice(-length))) return length;
	}
	return 0;
};

/**
 * Strip memory blocks from a (possibly still-streaming) reply. Pure and
 * idempotent: re-running it over already-extracted text is a no-op, so the
 * same string is never stripped twice.
 *
 * A complete `<memory>…</memory>` block is removed and its content returned
 * as a note. If an opening tag has no matching close yet, the visible text
 * is truncated at the tag — the rest of the block may still be arriving — so
 * neither the marker nor the partial block ever renders. A tail that is a
 * partial tag (`…text <mem`) is truncated too, for the same reason.
 */
export const extractMemories = (text: string): ExtractedMemories => {
	const memories: string[] = [];
	const stripped = text.replace(BLOCK, (_match, inner: string) => {
		const note = normalize(inner);
		if (note !== "") memories.push(note);
		return "";
	});
	// An unterminated opening tag hides everything from it onward.
	const open = stripped.indexOf(MEMORY_TAG_OPEN);
	if (open !== -1) return { text: stripped.slice(0, open), memories };
	// Otherwise only a tag still mid-arrival at the very end is hidden.
	const partial = partialTagSuffix(stripped);
	return { text: stripped.slice(0, stripped.length - partial), memories };
};

/**
 * System-prompt section describing the memory feature plus the current
 * notes. Returns "" when there are none, so an app with no notes sends
 * byte-identical requests to before the feature existed.
 */
export const memoryPrompt = (notes: readonly MemoryNote[]): string => {
	if (notes.length === 0) return "";
	const list = notes.map((note) => `- ${note.text}`).join("\n");
	return [
		"End your reply with one or more <memory> blocks to durably remember facts",
		"about the user (preferences, environment, ongoing projects). Put one fact",
		"per block, e.g. <memory>the user prefers terse answers</memory>. Omit the",
		"blocks entirely when nothing is worth remembering.",
		"",
		"Facts remembered so far:",
		list,
	].join("\n");
};

/**
 * Merge newly extracted note texts into the stored list. Pure: the clock is
 * passed in, never read from the environment. Trims, drops duplicates
 * case-insensitively (against existing notes and within the additions),
 * stamps id/createdAt/`source: "model"`, then caps at MAX_MEMORY_NOTES
 * keeping the newest.
 */
export const mergeMemories = (
	existing: readonly MemoryNote[],
	additions: readonly string[],
	now: number,
): readonly MemoryNote[] => {
	const seen = new Set(existing.map((note) => note.text.trim().toLowerCase()));
	const merged = [...existing];
	for (const addition of additions) {
		const text = addition.trim().slice(0, MAX_MEMORY_NOTE_LENGTH);
		if (text === "") continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push({ id: nextMemoryId(), text, createdAt: now, source: "model" });
	}
	// Keep the newest MAX_MEMORY_NOTES: the additions sit at the tail.
	return merged.slice(-MAX_MEMORY_NOTES);
};
