import { describe, expect, test } from "bun:test";
import type { MemoryNote } from "@lib/db/types";
import {
	extractMemories,
	MAX_MEMORY_NOTE_LENGTH,
	MAX_MEMORY_NOTES,
	MEMORY_TAG_OPEN,
	memoryLogLines,
	memoryPrompt,
	mergeMemories,
	recordMemories,
} from "./memory";
import { addMemory, type MemoryEntry } from "./memoryNotes";

const NOW = 1_000;

const live = (id: string, content: string): MemoryEntry => ({
	id,
	content,
	updatedAt: NOW,
	history: [],
});

describe("memoryPrompt", () => {
	test("is byte-identical when there are no memories (the preserved property)", () => {
		expect(memoryPrompt([])).toBe("");
	});

	test("prints id — content lines and the four rules", () => {
		const prompt = memoryPrompt([
			live("editor-theme", "the user prefers dark editors"),
			live("editor-font", "the user edits in a mono font"),
		]);
		// An id the model can reference without a call.
		expect(prompt).toContain("editor-theme — the user prefers dark editors");
		expect(prompt).toContain("editor-font — the user edits in a mono font");
		// The tag stays documented as the fallback.
		expect(prompt).toContain(MEMORY_TAG_OPEN);
		// The four rules the spec names.
		expect(prompt).toContain("Update a memory in place");
		expect(prompt).toContain("Never record a tool's availability");
		expect(prompt).toContain("Never record per-session transient state");
		expect(prompt).toContain("A newer memory supersedes a stale one");
	});

	test("a removed memory is not injected", () => {
		expect(
			memoryPrompt([{ ...live("gone", "stale"), deletedAt: NOW + 1 }]),
		).toBe("");
	});
});

describe("extractMemories never truncates a message", () => {
	test("a complete block mid-prose keeps everything before and after it", () => {
		const out = extractMemories(
			"before <memory>the user likes tea</memory> after",
		);
		expect(out.text).toBe("before  after");
		expect(out.memories).toEqual(["the user likes tea"]);
		expect(out.malformed).toBe(false);
	});

	test("a reply merely quoting a partial marker renders whole", () => {
		const text = "the docs call the opening marker <mem";
		const out = extractMemories(text);
		expect(out.text).toBe(text);
		expect(out.memories).toEqual([]);
		expect(out.malformed).toBe(false);
	});

	test("a stream ending in a partial tag neither chops the text nor loses a complete block", () => {
		const out = extractMemories("kept <memory>first</memory> tail <mem");
		expect(out.text).toBe("kept  tail <mem");
		expect(out.memories).toEqual(["first"]);
		expect(out.malformed).toBe(false);
	});

	test("an unterminated block is dropped, flagged, and not half-stored", () => {
		const out = extractMemories("kept text <memory>half a fact");
		expect(out.text).toBe("kept text ");
		expect(out.memories).toEqual([]);
		expect(out.malformed).toBe(true);
	});

	test("only an unterminated block is flagged malformed", () => {
		expect(extractMemories("a plain reply").malformed).toBe(false);
		expect(extractMemories("note <memory>fact</memory>").malformed).toBe(false);
		expect(extractMemories("quote <mem").malformed).toBe(false);
	});

	test("re-running extraction over already-extracted text is a no-op", () => {
		const first = extractMemories("a <memory>fact</memory> b <mem");
		const second = extractMemories(first.text);
		expect(second.text).toBe(first.text);
		expect(second.memories).toEqual([]);
		const clean = extractMemories("a <memory>fact</memory> b").text;
		expect(extractMemories(clean)).toEqual({
			text: clean,
			memories: [],
			malformed: false,
		});
	});
});

describe("memoryLogLines", () => {
	test("a malformed extraction yields exactly one log line, a clean one none", () => {
		expect(memoryLogLines(extractMemories("all good"))).toEqual([]);
		const lines = memoryLogLines(extractMemories("kept <memory>half"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(MEMORY_TAG_OPEN);
	});
});

describe("the tag path routes through the one mutator", () => {
	test("a tag-created memory and a tool-created one are indistinguishable", () => {
		const content = "the user prefers dark editors";
		const toolCreated = addMemory([], "editor-theme", content, NOW);
		expect(toolCreated.ok).toBe(true);
		if (!toolCreated.ok) return;
		const recorded = recordMemories([], [], [content], NOW);
		expect(recorded.notes).toHaveLength(1);
		const tagNote = recorded.notes[0];
		if (!tagNote) return;
		// The generated id, not a model choice.
		expect(tagNote.id).toMatch(/^memory-[0-9a-f-]{36}$/);
		// The generated id, checked above: now pin every other field by hand, so a
		// rename, a shape drift, or a stray extra field fails this half.
		expect(tagNote).toEqual({
			id: tagNote.id,
			content,
			updatedAt: NOW,
			history: [],
			deletedAt: undefined,
		});
		// The legacy mirror carries the same generated id and text.
		expect(recorded.memories).toHaveLength(1);
		expect(recorded.memories[0]?.id).toBe(tagNote.id);
		expect(recorded.memories[0]?.text).toBe(content);
	});

	test("the tag path writes both stores, and dedupe drops an addition from both", () => {
		const legacy: MemoryNote[] = [
			{
				id: "note-1",
				text: "the user likes tea",
				createdAt: 5,
				source: "model",
			},
		];
		const notes: readonly MemoryEntry[] = [live("tea", "the user likes tea")];
		const recorded = recordMemories(
			legacy,
			notes,
			["The User Likes Tea", "the user uses zed"],
			NOW,
		);
		// The case-insensitive duplicate reached neither store; the new fact
		// reached both.
		expect(recorded.memories.map((note) => note.text)).toEqual([
			"the user likes tea",
			"the user uses zed",
		]);
		expect(recorded.notes.map((note) => note.content)).toEqual([
			"the user likes tea",
			"the user uses zed",
		]);
		// Additive: the existing legacy note is the same object, not rewritten.
		expect(recorded.memories[0]).toBe(legacy[0]);
		// The mutator copies, so the existing entry is deep-equal and the input
		// array it came from is untouched.
		expect(recorded.notes[0]).toEqual(notes[0]);
		expect(notes).toHaveLength(1);
	});

	test("the legacy mirror keeps the newest MAX_MEMORY_NOTES", () => {
		const legacy: MemoryNote[] = Array.from(
			{ length: MAX_MEMORY_NOTES },
			(_, i) => ({
				id: `old-${i}`,
				text: `old note ${i}`,
				createdAt: i,
				source: "model" as const,
			}),
		);
		const recorded = recordMemories(legacy, [], ["a fresh fact"], NOW);
		expect(recorded.memories).toHaveLength(MAX_MEMORY_NOTES);
		expect(recorded.memories.at(-1)?.text).toBe("a fresh fact");
		expect(recorded.memories.map((n) => n.id)).not.toContain("old-0");
		// The new store holds the fresh fact under its generated id.
		expect(recorded.notes.map((n) => n.content)).toEqual(["a fresh fact"]);
	});

	test("a long addition is truncated to MAX_MEMORY_NOTE_LENGTH in both stores", () => {
		const long = "x".repeat(500);
		const recorded = recordMemories([], [], [long], NOW);
		const stored = recorded.memories[0]?.text ?? "";
		expect(stored).toHaveLength(MAX_MEMORY_NOTE_LENGTH);
		expect(recorded.notes[0]?.content).toBe(stored);
	});

	test("mergeMemories behaviour is unchanged: dedupe then the newest cap", () => {
		const merged = mergeMemories(
			[{ id: "n-1", text: "kept", createdAt: 1, source: "user" }],
			["kept", "  ", "fresh"],
			NOW,
		);
		expect(merged.map((n) => n.text)).toEqual(["kept", "fresh"]);
		expect(merged[0]?.id).toBe("n-1");
	});

	test("the tag path dedupes against the live store, not only the mirror", () => {
		const content = "the user prefers dark editors";
		const toolCreated = addMemory([], "editor-theme", content, NOW);
		expect(toolCreated.ok).toBe(true);
		if (!toolCreated.ok) return;
		const notes = toolCreated.notes;
		const recorded = recordMemories([], notes, [content.toUpperCase()], NOW);
		expect(recorded.notes).toHaveLength(notes.length);
		expect(
			memoryPrompt(recorded.notes).match(new RegExp(content, "g"))?.length ?? 0,
		).toBe(1);
	});

	test("stores differ past the legacy cap by design", () => {
		const legacy = Array.from({ length: MAX_MEMORY_NOTES }, (_, i) => ({
			id: `old-${i}`,
			text: `old note ${i}`,
			createdAt: i,
			source: "model" as const,
		}));
		const notes = [live("a", "alpha"), live("b", "beta"), live("c", "gamma")];
		const recorded = recordMemories(legacy, notes, ["a fresh fact"], NOW);
		expect(recorded.memories).toHaveLength(MAX_MEMORY_NOTES);
		expect(recorded.notes).toHaveLength(notes.length + 1);
	});
});
