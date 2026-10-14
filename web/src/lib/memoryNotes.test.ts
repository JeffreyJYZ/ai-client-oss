import { describe, expect, test } from "bun:test";
import {
	addMemory,
	listMemories,
	MEMORY_DELETED_CAP,
	MEMORY_HISTORY_DEPTH,
	MEMORY_ID_PATTERN,
	type MemoryEntry,
	removeMemory,
	revertMemory,
	updateMemory,
} from "./memoryNotes";

const NOW = 1_000;

/** The pattern's shape: one leading char plus up to 63 more. */
const MAX_ID_LENGTH = 64;

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

	test("the id allowlist refuses an empty id and an over-long one, and accepts the longest", () => {
		const empty = addMemory([], "", "content", NOW);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.message).toContain("does not match");

		const tooLong = "a".repeat(MAX_ID_LENGTH + 1);
		const over = addMemory([], tooLong, "content", NOW);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.message).toContain(tooLong);

		// Both ends are anchored: the longest allowed id is accepted.
		expect(MEMORY_ID_PATTERN.test("a".repeat(MAX_ID_LENGTH))).toBe(true);
		expect(MEMORY_ID_PATTERN.test(tooLong)).toBe(false);
		const longest = addMemory([], "a".repeat(MAX_ID_LENGTH), "content", NOW);
		expect(longest.ok).toBe(true);
	});

	test("adding a taken live id is refused with the id and the update path", () => {
		const first = addMemory([], "note-1", "first", NOW);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = addMemory(first.notes, "note-1", "second", NOW + 1);
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.message).toContain("note-1");
			expect(second.message).toContain("memory_update");
			expect(second.message).not.toContain("memory_revert");
		}
	});

	test("re-adding a removed id is refused and names the restore path", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		// The id is still taken, but update would refuse it as deleted, so the
		// refusal must point at memory_revert or the model dead-ends.
		const again = addMemory(removed.notes, "note-1", "content", NOW + 2);
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.message).toContain("note-1");
			expect(again.message).toContain("memory_revert");
		}
	});

	test("remove is soft: the entry stays, with deletedAt set", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.notes).toHaveLength(1);
		const note = removed.notes[0];
		expect(note?.id).toBe("note-1");
		expect(note?.deletedAt).toBe(NOW + 1);
		expect(note?.content).toBe("content");
	});

	test("removing an already-deleted id is refused, naming it", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		const again = removeMemory(removed.notes, "note-1", NOW + 2);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.message).toContain("note-1");
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
		expect(revertedEdit.notes[0]?.content).toBe("original");
		// revert a removal
		const removed = removeMemory(revertedEdit.notes, "note-1", NOW + 3);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		const revertedRemoval = revertMemory(removed.notes, "note-1", NOW + 4);
		expect(revertedRemoval.ok).toBe(true);
		if (!revertedRemoval.ok) return;
		expect(revertedRemoval.notes[0]?.deletedAt).toBeUndefined();
	});

	test("revert with empty history is a refusal, not a no-op", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const reverted = revertMemory(added.notes, "note-1", NOW + 1);
		expect(reverted.ok).toBe(false);
		if (!reverted.ok) expect(reverted.message).toContain("note-1");
	});

	test("reverting twice after a removal is a refusal, not a silent no-op", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const removed = removeMemory(added.notes, "note-1", NOW + 1);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		const reverted = revertMemory(removed.notes, "note-1", NOW + 2);
		expect(reverted.ok).toBe(true);
		if (!reverted.ok) return;
		expect(reverted.notes[0]?.deletedAt).toBeUndefined();
		// The removal consumed the one history entry, so there is nothing left.
		const again = revertMemory(reverted.notes, "note-1", NOW + 3);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.message).toContain("note-1");
	});

	test("edit twice, revert twice: each revert steps back exactly one change", () => {
		const added = addMemory([], "note-1", "v0", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const first = updateMemory(added.notes, "note-1", "v1", NOW + 1);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = updateMemory(first.notes, "note-1", "v2", NOW + 2);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.notes[0]?.content).toBe("v2");
		const back1 = revertMemory(second.notes, "note-1", NOW + 3);
		expect(back1.ok).toBe(true);
		if (!back1.ok) return;
		expect(back1.notes[0]?.content).toBe("v1");
		const back2 = revertMemory(back1.notes, "note-1", NOW + 4);
		expect(back2.ok).toBe(true);
		if (!back2.ok) return;
		expect(back2.notes[0]?.content).toBe("v0");
	});

	test("an unknown id is refused, naming it, for update, remove and revert", () => {
		const updated = updateMemory([], "ghost", "content", NOW);
		expect(updated.ok).toBe(false);
		if (!updated.ok) expect(updated.message).toContain("ghost");
		const removed = removeMemory([], "ghost", NOW);
		expect(removed.ok).toBe(false);
		if (!removed.ok) expect(removed.message).toContain("ghost");
		const reverted = revertMemory([], "ghost", NOW);
		expect(reverted.ok).toBe(false);
		if (!reverted.ok) expect(reverted.message).toContain("ghost");
	});

	test("history keeps the newest entries and drops the oldest, by name", () => {
		let notes: readonly MemoryEntry[] = [];
		const added = addMemory(notes, "note-1", "v0", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		notes = added.notes;
		const updates = MEMORY_HISTORY_DEPTH + 3;
		for (let i = 1; i <= updates; i++) {
			const r = updateMemory(notes, "note-1", `v${i}`, NOW + i);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			notes = r.notes;
		}
		const last = notes[0];
		expect(last?.content).toBe(`v${updates}`);
		// Each update pushed the previous content; the bound keeps the newest,
		// so the first `updates - MEMORY_HISTORY_DEPTH` versions are gone.
		const firstKept = updates - MEMORY_HISTORY_DEPTH;
		const contents = last?.history.map((entry) => entry.content) ?? [];
		expect(contents).toEqual(
			Array.from(
				{ length: MEMORY_HISTORY_DEPTH },
				(_, i) => `v${firstKept + i}`,
			),
		);
		// `v0` is the oldest: dropping the newest instead would keep it and
		// lose the tail this asserts.
		expect(contents).not.toContain("v0");
		expect(contents).toHaveLength(MEMORY_HISTORY_DEPTH);
	});

	test("the soft-deleted cap keeps the newest and evicts the oldest, by name", () => {
		let all: readonly MemoryEntry[] = [];
		const total = MEMORY_DELETED_CAP + 5;
		for (let i = 0; i < total; i++) {
			const id = `d-${i}`;
			const a = addMemory(all, id, "x", NOW + i);
			expect(a.ok).toBe(true);
			if (!a.ok) return;
			all = a.notes;
			// Increasing timestamps: removal order is d-0, d-1, ... d-24.
			const rm = removeMemory(all, id, NOW + 100 + i);
			expect(rm.ok).toBe(true);
			if (!rm.ok) return;
			all = rm.notes;
		}
		const deletedIds = all
			.filter((n) => n.deletedAt !== undefined)
			.map((n) => n.id);
		const evicted = total - MEMORY_DELETED_CAP;
		const byNumber = (id: string): number => Number(id.slice("d-".length));
		// The whole surviving set, by name: a newest-first eviction would keep
		// the low ids instead and fail here.
		expect([...deletedIds].sort((a, b) => byNumber(a) - byNumber(b))).toEqual(
			Array.from({ length: MEMORY_DELETED_CAP }, (_, i) => `d-${evicted + i}`),
		);
		expect(deletedIds).not.toContain(`d-${0}`);
		expect(deletedIds).toContain(`d-${total - 1}`);
	});

	test("no operation mutates its input list", () => {
		const added = addMemory([], "note-1", "original", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const edited = updateMemory(added.notes, "note-1", "edited", NOW + 1);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		const input = edited.notes;
		const snapshot = JSON.stringify(input);
		// Each op must actually run (a refusal would pass vacuously).
		const a = addMemory(input, "note-2", "second", NOW + 2);
		expect(a.ok).toBe(true);
		expect(JSON.stringify(input)).toBe(snapshot);
		const u = updateMemory(input, "note-1", "again", NOW + 3);
		expect(u.ok).toBe(true);
		expect(JSON.stringify(input)).toBe(snapshot);
		const r = removeMemory(input, "note-1", NOW + 4);
		expect(r.ok).toBe(true);
		expect(JSON.stringify(input)).toBe(snapshot);
		// `input` is live with one history entry, so this mutates the draft.
		const v = revertMemory(input, "note-1", NOW + 5);
		expect(v.ok).toBe(true);
		expect(JSON.stringify(input)).toBe(snapshot);
	});

	test("a read cannot write: listMemories hands back copies", () => {
		const added = addMemory([], "note-1", "content", NOW);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const store = added.notes;
		const listed = listMemories(store, true);
		expect(listed).toHaveLength(1);
		// Fresh array, fresh entry and fresh history: no identity with the store.
		expect(listed).not.toBe(store);
		expect(listed[0]).not.toBe(store[0]);
		expect(listed[0]?.history).not.toBe(store[0]?.history);
		const first = listed[0];
		if (first) first.content = "tampered";
		expect(store[0]?.content).toBe("content");
		// The default (filtered) path must hand back fresh entries too: asserting only
		// array freshness here let a mutation that drops `map(copyEntry)` from this
		// branch pass all 16 tests (found by the fix round's re-review).
		const filtered = listMemories(store);
		expect(filtered).not.toBe(store);
		expect(filtered[0]).not.toBe(store[0]);
		expect(filtered[0]?.history).not.toBe(store[0]?.history);
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
