/**
 * The note store and its one mutator.
 *
 * Pure TypeScript: no Effect, no UI, no storage. Every write (add, update,
 * remove, revert — and the legacy tag path later) goes through `mutateList`,
 * the single mutator, so a tag-created note and a tool-created note are
 * indistinguishable afterwards.
 */

/** Id allowlist. Own schema: ids guard a different thing than plugin ids or
 *  built-in area ids, so it is deliberately not shared with them. */
export const MEMORY_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const MEMORY_HISTORY_DEPTH = 5;
export const MEMORY_DELETED_CAP = 20;

export interface MemoryNote {
	id: string;
	content: string;
	updatedAt: number;
	deletedAt?: number;
	history: readonly { content: string; at: number }[];
}

export type MemoryResult =
	| { ok: true; notes: readonly MemoryNote[] }
	| { ok: false; message: string };

interface MutableNote {
	id: string;
	content: string;
	updatedAt: number;
	deletedAt?: number;
	history: { content: string; at: number }[];
}

const toReadonly = (note: MutableNote): MemoryNote => ({
	id: note.id,
	content: note.content,
	updatedAt: note.updatedAt,
	deletedAt: note.deletedAt,
	history: note.history,
});

const fail = (message: string): MemoryResult => ({ ok: false, message });

const ok = (notes: readonly MemoryNote[]): MemoryResult => ({
	ok: true,
	notes,
});

/**
 * The single mutator. Every operation builds its result by handing a
 * transform to this function, which clones the input so it is never mutated.
 */
const mutateList = (
	notes: readonly MemoryNote[],
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
	return ok(result.notes.map(toReadonly));
};

const validId = (id: string): boolean => MEMORY_ID_PATTERN.test(id);

const findIndex = (notes: readonly MemoryNote[], id: string): number =>
	notes.findIndex((note) => note.id === id);

export const addMemory = (
	notes: readonly MemoryNote[],
	id: string,
	content: string,
	now: number,
): MemoryResult => {
	if (!validId(id)) {
		return fail(`id "${id}" does not match ${MEMORY_ID_PATTERN.source}`);
	}
	if (findIndex(notes, id) !== -1) {
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
	notes: readonly MemoryNote[],
	id: string,
	content: string,
	now: number,
): MemoryResult => {
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
	notes: readonly MemoryNote[],
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
	notes: readonly MemoryNote[],
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
	notes: readonly MemoryNote[],
	includeDeleted: boolean = false,
): readonly MemoryNote[] => {
	if (includeDeleted) return [...notes];
	return notes.filter((note) => note.deletedAt === undefined);
};
