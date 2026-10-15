import type { MemoryNote } from "@lib/db/types";
import {
	addMemory,
	MAX_MEMORY_NOTE_LENGTH,
	type MemoryEntry,
} from "@lib/memoryNotes";

/** The note store's content bound, re-exported for the tag path and the UI. */
export { MAX_MEMORY_NOTE_LENGTH };

/**
 * Tag pair the model wraps memory blocks in, inside its own reply text. The
 * tag path is the **documented fallback** for endpoints that cannot be sent
 * tool declarations; a block creates a note through the same single mutator
 * the memory tools use (`lib/memoryNotes.ts`), so the two paths cannot
 * disagree about what a memory is.
 */
export const MEMORY_TAG_OPEN = "<memory>";
export const MEMORY_TAG_CLOSE = "</memory>";

/**
 * The bound that actually governs the request: `memoryPrompt` sends at most
 * this many live notes, newest first, so a chatty model cannot grow the
 * injected prompt without bound. It is a bound on **what is sent**, never on
 * what is stored — the store and the UI keep every note. The legacy
 * `Settings.memories` mirror is capped by the same constant for its own
 * historical reason; that cap no longer governs what reaches the wire.
 */
export const MAX_MEMORY_NOTES = 50;

/** One complete block; the lazy quantifier keeps two blocks from merging. */
const BLOCK = new RegExp(
	`${MEMORY_TAG_OPEN}([\\s\\S]*?)${MEMORY_TAG_CLOSE}`,
	"g",
);

export interface ExtractedMemories {
	/**
	 * Reply text with every complete block removed. A complete opening tag with
	 * no matching close is a malformed attempt: its block is dropped from the
	 * text (and reported via {@link ExtractedMemories.malformed}) rather than
	 * rendered. A *partial* tag (`…text <mem`) is ordinary prose and is left
	 * whole — see {@link extractMemories}.
	 */
	readonly text: string;
	/** Trimmed block contents, in order; whitespace-only blocks dropped. */
	readonly memories: readonly string[];
	/**
	 * True when a complete opening tag had no matching close. Surfaced so the
	 * caller that **stores** the reply can log once; this module stays pure and
	 * the streaming render path never logs.
	 */
	readonly malformed: boolean;
}

/** The tag path's id source, injected into `recordMemories` so it stays pure
 *  and testable: the tag path generates the id, never the model. */
const nextMemoryId = (): string => `memory-${crypto.randomUUID()}`;

/** Normalise one block's content: collapse newlines to spaces, then trim. */
const normalize = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/**
 * Strip memory blocks from a (possibly still-streaming) reply. Pure and
 * idempotent: re-running it over already-extracted text is a no-op, so the
 * same string is never stripped twice.
 *
 * **No marker truncates a message.** A complete `<memory>…</memory>` block is
 * removed and its content returned as a note. A complete opening tag with no
 * matching close is a malformed memory attempt — its block is dropped (and
 * flagged) so the marker never renders. A *partial* tag at the end (`…text
 * <mem`) is ordinary prose and is rendered whole: chopping it would truncate
 * real text, which is worse. A consequence of that trade is that a
 * partially-arrived tag can render for one frame while streaming.
 */
export const extractMemories = (text: string): ExtractedMemories => {
	const memories: string[] = [];
	const stripped = text.replace(BLOCK, (_match, inner: string) => {
		const note = normalize(inner);
		if (note !== "") memories.push(note);
		return "";
	});
	// A complete opening tag with no matching close now: drop its block, never
	// render the marker or store the half-written content.
	const open = stripped.indexOf(MEMORY_TAG_OPEN);
	if (open !== -1) {
		return { text: stripped.slice(0, open), memories, malformed: true };
	}
	return { text: stripped, memories, malformed: false };
};

/**
 * The lines a caller should log when it stores an extraction: none for a clean
 * one, exactly one for a malformed block. Pure, so the log decision is
 * testable without an Effect runtime, and `state/chat.ts` emits it once per
 * stored reply rather than per streamed frame.
 */
export const memoryLogLines = (
	extracted: ExtractedMemories,
): readonly string[] =>
	extracted.malformed
		? [
				`memory: dropped an unterminated ${MEMORY_TAG_OPEN} block from the reply`,
			]
		: [];

/**
 * System-prompt section describing the memory feature plus the current live
 * notes, one `id — content` line each so the model can reference an id without
 * a call. Returns "" when there are none (a removed note is not a note), so an
 * app with no notes sends byte-identical requests to before the feature
 * existed.
 */
export const memoryPrompt = (notes: readonly MemoryEntry[]): string => {
	// The prompt bound, and the only bound on what a request carries: at most
	// MAX_MEMORY_NOTES live notes, newest first (a newer memory supersedes a
	// stale one). Notes beyond it stay in the store and in the UI — this bound
	// decides what is *sent*, never what is kept, so nothing is deleted to
	// satisfy it.
	const live = notes
		.filter((note) => note.deletedAt === undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, MAX_MEMORY_NOTES);
	if (live.length === 0) return "";
	const list = live.map((note) => `${note.id} — ${note.content}`).join("\n");
	return [
		"You have a durable memory, kept across conversations. Keep it correct:",
		"- Update a memory in place when a fact changes; never add a second note",
		"  that contradicts the first.",
		"- Never record a tool's availability: the tools change from turn to turn,",
		"  so the note would be stale the moment it is written.",
		"- Never record per-session transient state: a glitch in one session is",
		"  not a fact about the user.",
		"- A newer memory supersedes a stale one; when two disagree, trust the",
		"  one with the later timestamp.",
		`- Keep each memory short: content over ${MAX_MEMORY_NOTE_LENGTH} characters`,
		"  is refused, so shorten it instead of retrying unchanged.",
		"",
		"End your reply with one or more <memory> blocks to durably remember facts",
		"about the user (preferences, environment, ongoing projects). Put one fact",
		"per block, e.g. <memory>the user prefers terse answers</memory>. Omit the",
		"blocks entirely when nothing is worth remembering. (The block is the",
		"fallback for endpoints that cannot be sent the memory tools.)",
		"",
		"Facts remembered so far:",
		list,
	].join("\n");
};

/**
 * The one dedupe decision the tag path's write makes: trim (and cap the length
 * of) each addition, drop duplicates case-insensitively against the existing
 * notes and within the additions, and keep order. Pure.
 *
 * The length cap **truncates** here rather than refusing, because this is the
 * tag path — it parses a reply, where there is nobody to hand a refusal to.
 * The tools refuse an over-long content instead (`lib/memoryNotes.ts`): the
 * same limit, handled by writer, and the one deliberate asymmetry between
 * them.
 */
const acceptedTexts = (
	legacy: readonly MemoryNote[],
	store: readonly MemoryEntry[],
	additions: readonly string[],
): readonly string[] => {
	const seen = new Set([
		...legacy.map((note) => note.text.trim().toLowerCase()),
		...store.map((note) => note.content.trim().toLowerCase()),
	]);
	const accepted: string[] = [];
	for (const addition of additions) {
		const text = addition.trim().slice(0, MAX_MEMORY_NOTE_LENGTH);
		if (text === "") continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		accepted.push(text);
	}
	return accepted;
};

/** The pair of stores one tag-path write touches, both of them. */
export interface RecordedMemories {
	/** The legacy `Settings.memories` array, still written for older apps. */
	readonly memories: readonly MemoryNote[];
	/** The note store, `Settings.memoryNotes`, written through T1's mutator. */
	readonly notes: readonly MemoryEntry[];
}

/**
 * Record one reply's `<memory>` blocks into **both** stores. The tag path is
 * the fallback writer, so it routes through T1's single mutator
 * (`addMemory`) exactly as the tools do — the only difference is who names the
 * id: here it is generated (`memory-<uuid>`), never the model's choice.
 *
 * The accepted set is decided **once** by {@link acceptedTexts}, and both
 * writes take exactly that set, so the new store can never hold something the
 * legacy array refused as a duplicate. The cap is the legacy array's own
 * bound (the new store bounds history and soft-deletions instead), so the two
 * stores bound themselves differently by design — but neither invents its own
 * dedupe. Pure: the clock and the id source are passed in.
 */
export const recordMemories = (
	legacy: readonly MemoryNote[],
	notes: readonly MemoryEntry[],
	additions: readonly string[],
	now: number,
	makeId: () => string = nextMemoryId,
): RecordedMemories => {
	const accepted = acceptedTexts(legacy, notes, additions);
	if (accepted.length === 0) return { memories: legacy, notes };
	const mirrored: MemoryNote[] = [];
	let next = notes;
	for (const text of accepted) {
		const id = makeId();
		mirrored.push({ id, text, createdAt: now, source: "model" });
		const result = addMemory(next, id, text, now);
		// The id is generated and unique, so `addMemory` cannot refuse; keep the
		// store unchanged rather than invent a differently-shaped entry if it
		// ever did.
		if (result.ok) next = result.notes;
	}
	return {
		memories: [...legacy, ...mirrored].slice(-MAX_MEMORY_NOTES),
		notes: next,
	};
};
