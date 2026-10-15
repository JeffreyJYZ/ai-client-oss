import type { MemoryEntry } from "@lib/memoryNotes";

/**
 * The Memory section's **pure** half: the note store in, the two lists the
 * section renders out. Kept out of the component so every behaviour below is a
 * value in and a value out — the repo has no React renderer harness, so the
 * view-model is what the tests drive and the component only renders its output
 * and wires the controls to T1's operations (`lib/memoryNotes.ts`).
 *
 * Two lists, not one filtered inline: a soft-deleted note (`deletedAt` set) is
 * a **view** of the same store, and naming the split here is what makes
 * "recently deleted" testable rather than a detail of the JSX.
 */

/** One row: a note's identity, its content, when it last changed, and whether
 *  undo (or restore) has a step to take. */
export interface MemoryRow {
	/** The note's own id, shown beside the content and the key T1's ops take. */
	readonly id: string;
	readonly content: string;
	/** Last-changed timestamp, copied from the entry — the row's source of truth. */
	readonly updatedAt: number;
	/** `updatedAt` against `now`, for display ("just now", "3h ago", a date). */
	readonly changed: string;
	/** Whether revert/restore has a step to take. */
	readonly canRevert: boolean;
	/** Why the control is disabled; present only when {@link canRevert} is false. */
	readonly revertReason?: string;
}

/** The section's whole view-model: the live notes and the soft-deleted ones. */
export interface MemoryRows {
	readonly live: readonly MemoryRow[];
	readonly deleted: readonly MemoryRow[];
}

/** The visible reason a revert control is disabled — a user can read it. */
export const NO_REVERT_REASON = "No earlier version to go back to.";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A human label for a last-changed time. `now` is injected (never read from the
 * clock) so the label is a pure function of its inputs and a test can pin it.
 */
export const changedLabel = (updatedAt: number, now: number): string => {
	const age = now - updatedAt;
	if (age < MINUTE) return "just now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
	if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
	return new Date(updatedAt).toLocaleDateString();
};

const toRow = (note: MemoryEntry, now: number): MemoryRow => {
	const canRevert = note.history.length > 0;
	return {
		id: note.id,
		content: note.content,
		updatedAt: note.updatedAt,
		changed: changedLabel(note.updatedAt, now),
		canRevert,
		...(canRevert ? {} : { revertReason: NO_REVERT_REASON }),
	};
};

/** Newest change first, so the list reads like the old one (which reversed the
 *  append-only store). `Array.prototype.sort` is stable, so equal timestamps
 *  keep their store order. */
const newestFirst = (rows: readonly MemoryRow[]): readonly MemoryRow[] =>
	[...rows].sort((a, b) => b.updatedAt - a.updatedAt);

/** The view-model: `notes` in, the live and recently-deleted rows out. */
export const memoryRows = (
	notes: readonly MemoryEntry[],
	now: number,
): MemoryRows => ({
	live: newestFirst(
		notes
			.filter((note) => note.deletedAt === undefined)
			.map((n) => toRow(n, now)),
	),
	deleted: newestFirst(
		notes
			.filter((note) => note.deletedAt !== undefined)
			.map((n) => toRow(n, now)),
	),
});
