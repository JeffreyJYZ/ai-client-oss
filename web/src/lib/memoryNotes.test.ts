import { describe, expect, test } from "bun:test";
import {
	addMemory,
	listMemories,
	MEMORY_DELETED_CAP,
	MEMORY_HISTORY_DEPTH,
	MEMORY_ID_PATTERN,
	type MemoryNote,
	removeMemory,
	revertMemory,
	updateMemory,
} from "./memoryNotes";

const NOW = 1_000;

describe("memoryNotes", () => {
	test("an id must match the allowlist, and a bad one is refused with a message", () => {
		const res = addMemory([], "Bad ID", "content", NOW);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("Bad ID");
		// pattern is anchored
		expect(MEMORY_ID_PATTERN.test("good.id-1")).toBe(true);
		expect(MEMORY_ID_PATTERN.test("Bad ID")).toBe(false);
		expect(MEMORY_ID_PATTERN.test(" leading")).toBe(false);
	});

	test("adding a taken id is refused with the id in the message", () => {
		const first = addMemory([], "note-1", "first", NOW);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = addMemory(first.notes, "note-1", "second", NOW + 1);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.message).toContain("note-1");
	});

	test("remove is soft: the entry stays, with deletedAt set", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.notes).toHaveLength(1);
		const note = removed.notes[0]!;
		expect(note.id).toBe("note-1");
		expect(note.deletedAt).toBe(NOW + 1);
		expect(note.content).toBe("content");
	});

	test("revert undoes a removal, and undoes an edit", () => {
		const added = addMemory([], "note-1", "original", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		// revert an edit
		const updated = updateMemory(added.notes, "note-1", "edited", NOW + 1);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		const revertedEdit = revertMemory(updated.notes, "note-1", NOW + 2);
		expect(revertedEdit.ok).toBe(true);
		if (!revertedEdit.ok) return;
		expect(revertedEdit.notes[0]!.content).toBe("original");
		// revert a removal
		const removed = removeMemory(revertedEdit.notes, "note-1", NOW + 3);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		const revertedRemoval = revertMemory(removed.notes, "note-1", NOW + 4);
		expect(revertedRemoval.ok).toBe(true);
		if (!revertedRemoval.ok) return;
		expect(revertedRemoval.notes[0]!.deletedAt).toBeUndefined();
	});

	test("revert with empty history is a refusal, not a no-op", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const reverted = revertMemory(added.notes, "note-1", NOW + 1);
		expect(reverted.ok).toBe(false);
		if (!reverted.ok) expect(reverted.message).toContain("note-1");
	});

	test("history and the deleted list are bounded", () => {
		let notes: readonly MemoryNote[] = [];
		const first = addMemory(notes, "note-1", "v0", NOW);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		notes = first.notes;
		for (let i = 1; i <= MEMORY_HISTORY_DEPTH + 3; i++) {
			const r = updateMemory(notes, "note-1", `v${i}`, NOW + i);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			notes = r.notes;
		}
		const last = notes[0]!;
		expect(last.history.length).toBeLessThanOrEqual(MEMORY_HISTORY_DEPTH);
		// deleted cap
		let all: readonly MemoryNote[] = [];
		for (let i = 0; i < MEMORY_DELETED_CAP + 5; i++) {
			const id = `d-${i}`;
			const a = addMemory(all, id, "x", NOW + i);
			expect(a.ok).toBe(true);
			if (!a.ok) return;
			all = a.notes;
			const rm = removeMemory(all, id, NOW + 100 + i);
			expect(rm.ok).toBe(true);
			if (!rm.ok) return;
			all = rm.notes;
		}
		const deletedCount = all.filter((n) => n.deletedAt !== undefined).length;
		expect(deletedCount).toBeLessThanOrEqual(MEMORY_DELETED_CAP);
	});

	test("a tag-created note and a tool-created note are indistinguishable", () => {
		// A tag uses a generated id; a tool uses an agent-chosen id. Both go
		// through addMemory, so their shapes are identical aside from the id.
		const tool = addMemory([], "agent-id", "fact", NOW);
		const tag = addMemory([], `memory-${"a".repeat(8)}`, "fact", NOW);
		expect(tool.ok).toBe(true);
		expect(tag.ok).toBe(true);
		if (!tool.ok || !tag.ok) return;
		const toolKeys = Object.keys(tool.notes[0]!).sort();
		const tagKeys = Object.keys(tag.notes[0]!).sort();
		expect(toolKeys).toEqual(tagKeys);
		expect(typeof tool.notes[0]!.updatedAt).toBe("number");
		expect(Array.isArray(tool.notes[0]!.history)).toBe(true);
	});

	test("listMemories filters deleted by default", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(listMemories(removed.notes)).toHaveLength(0);
		expect(listMemories(removed.notes, true)).toHaveLength(1);
	});
});
