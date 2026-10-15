/**
 * The note store and its one mutator.
 *
 * Pure TypeScript: no Effect, no UI, no storage. Every write (add, update,
 * remove, revert) goes through `mutateList`, the single mutator shared by the
 * memory tools and the legacy tag path (`lib/memory.ts`), so both writers stay
 * on one shape.
 */

/** Id allowlist. Own schema: ids guard a different thing than plugin ids or
 *  built-in area ids, so it is deliberately not shared with them. */
export const MEMORY_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const MEMORY_HISTORY_DEPTH = 5;
export const MEMORY_DELETED_CAP = 20;

/**
 * The longest content a note may hold. This is the **store's** bound, so the
 * two tools that write through `addMemory`/`updateMemory` refuse over-long
 * content with a readable message naming it — a tool path has a model on the
 * other end that can shorten the note and retry, and a refusal is a result.
 *
 * The tag path (`lib/memory.ts`'s `recordMemories`) **truncates** to this same
 * constant instead of refusing: it parses a reply, where there is nobody to
 * hand a refusal to. That divergence is deliberate and is the one way the two
 * writers are not indistinguishable — they agree on shape and on this limit,
 * and differ only in how a violation is handled.
 */
export const MAX_MEMORY_NOTE_LENGTH = 200;

export interface MemoryEntry {
	id: string;
	content: string;
	updatedAt: number;
	deletedAt?: number;
	history: readonly { content: string; at: number }[];
}

export type MemoryResult =
	| { ok: true; notes: readonly MemoryEntry[] }
	| { ok: false; message: string };

interface MutableNote {
	id: string;
	content: string;
	updatedAt: number;
	deletedAt?: number;
	history: { content: string; at: number }[];
}

/** A fresh copy of one entry. Nothing the caller can reach is the store's own
 *  object, array or history entry, so a returned value is never a write path. */
const copyEntry = (note: MemoryEntry): MemoryEntry => ({
	id: note.id,
	content: note.content,
	updatedAt: note.updatedAt,
	deletedAt: note.deletedAt,
	history: note.history.map((entry) => ({
		content: entry.content,
		at: entry.at,
	})),
});

const fail = (message: string): MemoryResult => ({ ok: false, message });

const ok = (notes: readonly MemoryEntry[]): MemoryResult => ({
	ok: true,
	notes,
});

/**
 * The single mutator. Every operation builds its result by handing a
 * transform to this function, which clones the input so it is never mutated.
 */
const mutateList = (
	notes: readonly MemoryEntry[],
	transform: (
		draft: MutableNote[],
	) => { notes: MutableNote[] } | { message: string },
): MemoryResult => {
	const draft: MutableNote[] = notes.map((note) => ({
		id: note.id,
		content: note.content,
		updatedAt: note.updatedAt,
		deletedAt: note.deletedAt,
		history: note.history.map((entry) => ({
			content: entry.content,
			at: entry.at,
		})),
	}));
	const result = transform(draft);
	if ("message" in result) return fail(result.message);
	return ok(result.notes.map(copyEntry));
};

const validId = (id: string): boolean => MEMORY_ID_PATTERN.test(id);

/**
 * Refuse a content over the length cap, naming the limit so a model that
 * overshoots can correct itself. The length is a property of the argument
 * alone, so it is decided before any store lookup — a refusal is a result, as
 * this module's contract requires.
 *
 * The tag path does **not** reach this refusal with an over-long string: it
 * truncates to the same constant before calling `addMemory`, because a reply
 * has nobody to hand a refusal to (see `lib/memory.ts`).
 */
const overLength = (content: string): MemoryResult | undefined =>
	content.length > MAX_MEMORY_NOTE_LENGTH
		? fail(
				`content is too long: ${content.length} characters, the limit is ${MAX_MEMORY_NOTE_LENGTH}`,
			)
		: undefined;

const findIndex = (notes: readonly MemoryEntry[], id: string): number =>
	notes.findIndex((note) => note.id === id);

export const addMemory = (
	notes: readonly MemoryEntry[],
	id: string,
	content: string,
	now: number,
): MemoryResult => {
	const tooLong = overLength(content);
	if (tooLong) return tooLong;
	if (!validId(id)) {
		return fail(`id "${id}" does not match ${MEMORY_ID_PATTERN.source}`);
	}
	const existing = notes.find((note) => note.id === id);
	if (existing) {
		// A soft-deleted id is still taken, but the way out is restore, not
		// update — so name it, or a model follows the wrong refusal.
		if (existing.deletedAt !== undefined) {
			return fail(
				`id "${id}" was removed — use memory_revert to restore it, or pick another`,
			);
		}
		return fail(
			`id "${id}" already exists — use memory_update, or pick another`,
		);
	}
	return mutateList(notes, (draft) => {
		draft.push({
			id,
			content,
			updatedAt: now,
			history: [],
		});
		return { notes: draft };
	});
};

export const updateMemory = (
	notes: readonly MemoryEntry[],
	id: string,
	content: string,
	now: number,
): MemoryResult => {
	const tooLong = overLength(content);
	if (tooLong) return tooLong;
	const index = findIndex(notes, id);
	if (index === -1) {
		return fail(`id "${id}" not found`);
	}
	const atCheck = notes[index];
	if (!atCheck || atCheck.deletedAt !== undefined) {
		return fail(`id "${id}" is deleted — restore it first`);
	}
	return mutateList(notes, (draft) => {
		const target = draft.find((n) => n.id === id);
		if (!target) return { message: `id "${id}" not found` };
		const history = target.history.concat({
			content: target.content,
			at: target.updatedAt,
		});
		const bounded =
			history.length > MEMORY_HISTORY_DEPTH
				? history.slice(history.length - MEMORY_HISTORY_DEPTH)
				: history;
		target.content = content;
		target.updatedAt = now;
		target.history = bounded;
		return { notes: draft };
	});
};

export const removeMemory = (
	notes: readonly MemoryEntry[],
	id: string,
	now: number,
): MemoryResult => {
	const index = findIndex(notes, id);
	if (index === -1) {
		return fail(`id "${id}" not found`);
	}
	const toRemove = notes[index];
	if (!toRemove || toRemove.deletedAt !== undefined) {
		return fail(`id "${id}" is already deleted`);
	}
	return mutateList(notes, (draft) => {
		const target = draft.find((n) => n.id === id);
		if (!target) return { message: `id "${id}" not found` };
		// Record the removal so revert can undo it.
		const history = target.history.concat({
			content: target.content,
			at: target.updatedAt,
		});
		const bounded =
			history.length > MEMORY_HISTORY_DEPTH
				? history.slice(history.length - MEMORY_HISTORY_DEPTH)
				: history;
		target.history = bounded;
		target.deletedAt = now;
		target.updatedAt = now;
		// Enforce the soft-deleted cap: drop the oldest soft-deleted beyond it.
		const deleted = draft
			.filter((n) => n.deletedAt !== undefined)
			.sort((a, b) => (a.deletedAt ?? 0) - (b.deletedAt ?? 0));
		if (deleted.length > MEMORY_DELETED_CAP) {
			const toDrop = new Set(
				deleted.slice(0, deleted.length - MEMORY_DELETED_CAP).map((n) => n.id),
			);
			const filtered = draft.filter((n) => !toDrop.has(n.id));
			return { notes: filtered };
		}
		return { notes: draft };
	});
};

export const revertMemory = (
	notes: readonly MemoryEntry[],
	id: string,
	now: number,
): MemoryResult => {
	const index = findIndex(notes, id);
	if (index === -1) {
		return fail(`id "${id}" not found`);
	}
	const toRevert = notes[index];
	if (!toRevert || toRevert.history.length === 0) {
		return fail(`id "${id}" has nothing to revert`);
	}
	return mutateList(notes, (draft) => {
		const target = draft.find((n) => n.id === id);
		if (!target) return { message: `id "${id}" not found` };
		const last = target.history[target.history.length - 1];
		if (!last) return { message: `id "${id}" has nothing to revert` };
		const nextHistory = target.history.slice(0, target.history.length - 1);
		// A removal is reverted by clearing deletedAt; an edit by restoring content.
		if (target.deletedAt !== undefined) {
			target.deletedAt = undefined;
		} else {
			target.content = last.content;
		}
		target.updatedAt = now;
		target.history = nextHistory;
		return { notes: draft };
	});
};

export const listMemories = (
	notes: readonly MemoryEntry[],
	includeDeleted: boolean = false,
): readonly MemoryEntry[] => {
	if (includeDeleted) return notes.map(copyEntry);
	return notes.filter((note) => note.deletedAt === undefined).map(copyEntry);
};
