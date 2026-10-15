import {
	addMemory,
	listMemories,
	MAX_MEMORY_NOTE_LENGTH,
	type MemoryEntry,
	type MemoryResult,
	removeMemory,
	revertMemory,
	updateMemory,
} from "@lib/memoryNotes";
import type { Disposable, Host } from "@lib/plugins/host";
import { registerTool, type Tool, type ToolOutcome } from "@lib/plugins/tools";
import { Effect } from "effect";
import {
	getSettings,
	setSettings,
	subscribe as subscribeSettings,
} from "@/state/settings";
import { MemorySection } from "@/ui/memory/MemorySection";

/**
 * The `app.memory` area: the five memory tools, registered only while memory is
 * enabled.
 *
 * **Registration is the enablement gate.** A registered tool is what the
 * outgoing body announces (`state/chat.ts` `registeredToolDeclarations` reads
 * the registry), so with `memoriesEnabled` off the five must be **absent from
 * the registry**, not merely refusing inside `execute`. The flag is a settings
 * field, so the area watches it and unregisters/registers as it flips.
 *
 * The tools themselves are thin: every operation is T1's
 * (`lib/memoryNotes.ts`), including every refusal message, so a second copy of
 * a refusal cannot drift from the module the UI also reads. Each `execute`
 * returns an **outcome**, never a fault — a refusal is a failed outcome whose
 * result text is T1's message.
 *
 * The settings access is one injected seam ({@link MemorySettingsSource}) so a
 * test drives the reactive half with a value in and a notification out, instead
 * of mutating the app's own store (which bun's shared module registry would leak
 * into every later suite, order-dependently). The app wires its real store in
 * {@link appMemorySettings}.
 *
 * Task 5 routes the Memory **settings section** through
 * {@link registerMemoryBuiltins} too, which is why the tool half is its own
 * function: the section is always registered with the area, the tools only while
 * the flag is on.
 */

/** The five wire names, in registration order. */
export const MEMORY_TOOL_NAMES: readonly string[] = [
	"memory_add",
	"memory_update",
	"memory_remove",
	"memory_revert",
	"memory_list",
];

/**
 * Everything the tools need from settings: the enablement flag, the note store,
 * the write, and change notifications. Narrow on purpose — a tool reads and
 * writes notes and never needs the rest of `Settings`.
 */
export interface MemorySettingsSource {
	/** Whether memory is on right now; read per registration, per change. */
	readonly enabled: () => boolean;
	/** The stored notes, as T1's operations take them. */
	readonly notes: () => readonly MemoryEntry[];
	/** Persist the list an operation returned. */
	readonly saveNotes: (notes: readonly MemoryEntry[]) => void;
	/** Notify on any settings change; returns the unsubscribe. */
	readonly subscribe: (listener: () => void) => () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * The call's id, or `""` when it is missing or not a string. The empty string is
 * then refused by T1's own allowlist/not-found message, so the id verdict stays
 * single-sourced rather than re-authored here.
 */
const readId = (input: unknown): string => {
	const record = isRecord(input) ? input : {};
	return typeof record.id === "string" ? record.id : "";
};

/** The call's content, or `undefined` when missing or not a string. */
const readContent = (input: unknown): string | undefined => {
	const record = isRecord(input) ? input : {};
	return typeof record.content === "string" ? record.content : undefined;
};

/** A failed outcome. The result text is the model's to read. */
const failure = (
	name: string,
	input: unknown,
	message: string,
): ToolOutcome => ({
	result: message,
	marker: `🧠 ${name} failed: ${message}`,
	failed: true,
	input,
});

/** A successful outcome. */
const success = (
	input: unknown,
	marker: string,
	result: string,
): ToolOutcome => ({ result, marker, failed: false, input });

/**
 * Translate one T1 result: a refusal becomes a failed outcome carrying T1's own
 * message and **writes nothing**; a success persists the returned list.
 */
const finish = (
	source: MemorySettingsSource,
	name: string,
	input: unknown,
	message: { readonly result: string; readonly marker: string },
	outcome: MemoryResult,
): ToolOutcome => {
	if (!outcome.ok) return failure(name, input, outcome.message);
	source.saveNotes(outcome.notes);
	return success(input, message.marker, message.result);
};

/** The `memory_list` result: one `id — content` line each, removed ones marked. */
const listText = (notes: readonly MemoryEntry[]): string =>
	notes.length === 0
		? "No memories are stored."
		: notes
				.map(
					(note) =>
						`${note.id} — ${note.content}${
							note.deletedAt === undefined ? "" : " (removed)"
						}`,
				)
				.join("\n");

const ID_PARAMETER = {
	type: "string",
	description:
		'The memory\'s id: lowercase letters, digits, dots, dashes and underscores, up to 64 characters, starting with a letter or digit, such as "editor-theme".',
} as const;

const CONTENT_PARAMETER = {
	type: "string",
	description: `The fact to remember, at most ${MAX_MEMORY_NOTE_LENGTH} characters.`,
} as const;

const ADD_DESCRIPTION =
	"Create a memory: a durable fact worth keeping across conversations, stored under an id you choose. Reach for this when the user tells you something they will want remembered. If the id is already taken the call is refused — use memory_update to change an existing memory, restore a removed one with memory_revert, or choose another id.";
const UPDATE_DESCRIPTION =
	"Replace the content of one existing memory by id, keeping the previous content so the change can be undone with memory_revert. Use this to correct or supersede a memory instead of adding a second one; an unknown or removed id is refused.";
const REMOVE_DESCRIPTION =
	"Remove a memory by id. The removal is soft: the memory leaves the live list but stays restorable with memory_revert, so a tool can never destroy a memory outright.";
const REVERT_DESCRIPTION =
	"Undo the most recent change to a memory: its last edit, or the removal that took it out of the live list. One call undoes one step; a memory with nothing to undo is refused.";
const LIST_DESCRIPTION =
	"List the memories you hold, with their ids and contents, so you can recover an id after losing your context. Set includeDeleted to also see removed memories.";

/**
 * The five tools over one settings source. Built per registration, so a
 * re-registration after an off/on toggle carries the then-current source.
 */
export const makeMemoryTools = (
	source: MemorySettingsSource,
): readonly Tool[] => {
	const add: Tool = {
		declaration: {
			name: "memory_add",
			description: ADD_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { id: ID_PARAMETER, content: CONTENT_PARAMETER },
				required: ["id", "content"],
			},
		},
		execute: (input) =>
			Effect.sync(() => {
				const content = readContent(input);
				if (content === undefined) {
					return failure(
						"memory_add",
						input,
						"memory_add was called without content.",
					);
				}
				const id = readId(input);
				return finish(
					source,
					"memory_add",
					input,
					{
						result: `Memory "${id}" saved.`,
						marker: `🧠 added memory "${id}"`,
					},
					addMemory(source.notes(), id, content, Date.now()),
				);
			}),
	};

	const update: Tool = {
		declaration: {
			name: "memory_update",
			description: UPDATE_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { id: ID_PARAMETER, content: CONTENT_PARAMETER },
				required: ["id", "content"],
			},
		},
		execute: (input) =>
			Effect.sync(() => {
				const content = readContent(input);
				if (content === undefined) {
					return failure(
						"memory_update",
						input,
						"memory_update was called without content.",
					);
				}
				const id = readId(input);
				return finish(
					source,
					"memory_update",
					input,
					{
						result: `Memory "${id}" updated.`,
						marker: `🧠 updated memory "${id}"`,
					},
					updateMemory(source.notes(), id, content, Date.now()),
				);
			}),
	};

	const remove: Tool = {
		declaration: {
			name: "memory_remove",
			description: REMOVE_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { id: ID_PARAMETER },
				required: ["id"],
			},
		},
		execute: (input) =>
			Effect.sync(() => {
				const id = readId(input);
				return finish(
					source,
					"memory_remove",
					input,
					{
						result: `Memory "${id}" removed; memory_revert can restore it.`,
						marker: `🧠 removed memory "${id}"`,
					},
					removeMemory(source.notes(), id, Date.now()),
				);
			}),
	};

	const revert: Tool = {
		declaration: {
			name: "memory_revert",
			description: REVERT_DESCRIPTION,
			parameters: {
				type: "object",
				properties: { id: ID_PARAMETER },
				required: ["id"],
			},
		},
		execute: (input) =>
			Effect.sync(() => {
				const id = readId(input);
				return finish(
					source,
					"memory_revert",
					input,
					{
						result: `Memory "${id}" stepped back one change.`,
						marker: `🧠 reverted memory "${id}"`,
					},
					revertMemory(source.notes(), id, Date.now()),
				);
			}),
	};

	const list: Tool = {
		declaration: {
			name: "memory_list",
			description: LIST_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					includeDeleted: {
						type: "boolean",
						description:
							"Also list memories that were removed, so a removed id can be restored with memory_revert.",
					},
				},
				required: [],
			},
		},
		execute: (input) =>
			Effect.sync(() => {
				const record = isRecord(input) ? input : {};
				const includeDeleted = record.includeDeleted === true;
				const notes = listMemories(source.notes(), includeDeleted);
				return success(
					input,
					`🧠 listed ${notes.length} memor${notes.length === 1 ? "y" : "ies"}`,
					listText(notes),
				);
			}),
	};

	return [add, update, remove, revert, list];
};

/** What one area's registration can do: register now, and follow changes. */
export interface MemoryToolRegistration {
	/** Register the five when memory is on, unregister when it is off. */
	readonly apply: () => void;
	/**
	 * Subscribe to the source and return the stop. The stop unsubscribes and
	 * unregisters; calling it twice is a no-op.
	 */
	readonly watch: () => () => void;
}

/**
 * The registration gate over one settings source. `handles` is the whole state:
 * an empty list means "not registered", a non-empty one means "registered", so
 * a change is applied only when it actually flips the state (a settings write
 * from a tool would otherwise re-register the five on every call).
 */
export const makeMemoryToolRegistration = (
	host: Host,
	source: MemorySettingsSource,
): MemoryToolRegistration => {
	let handles: readonly Disposable[] = [];

	const release = (): void => {
		for (const handle of handles) handle.dispose();
		handles = [];
	};

	const apply = (): void => {
		const shouldRegister = source.enabled();
		const registered = handles.length > 0;
		if (shouldRegister === registered) return;
		if (!shouldRegister) {
			release();
			return;
		}
		handles = makeMemoryTools(source).map((tool) => registerTool(host, tool));
	};

	const watch = (): (() => void) => {
		let stopped = false;
		const unsubscribe = source.subscribe(apply);
		return () => {
			if (stopped) return;
			stopped = true;
			unsubscribe();
			release();
		};
	};

	return { apply, watch };
};

/**
 * The app's source: the same settings store the UI reads and writes, so a tool
 * write shows in the section and a section toggle is seen by the gate.
 */
export const appMemorySettings: MemorySettingsSource = {
	enabled: () => getSettings().memoriesEnabled,
	notes: () => getSettings().memoryNotes,
	saveNotes: (notes) => setSettings({ memoryNotes: [...notes] }),
	subscribe: subscribeSettings,
};

/**
 * Register the five memory tools for the area's lifetime.
 *
 * The initial registration is **synchronous**, because `host.run` forks and a
 * scheduled fibre would leave the boot reconcile's synchronous registry readers
 * (and the catalog check) looking at an empty registry. The long-lived half is
 * the watch, started with `host.run` so the area's own `Scope` owns it — closing
 * the area (a reconcile, a toggle) interrupts the fibre and unsubscribes.
 */
export const registerMemoryTools = (host: Host): void => {
	const registration = makeMemoryToolRegistration(host, appMemorySettings);
	registration.apply();
	host.run(
		Effect.scoped(
			Effect.acquireRelease(
				Effect.sync(() => registration.watch()),
				(stop) => Effect.sync(() => stop()),
			).pipe(Effect.andThen(Effect.never)),
		),
	);
};

/**
 * The `app.memory` area's registrar: the five tools, and the Memory settings
 * section that owns them.
 *
 * The section is registered **unconditionally** (while the area is on): it
 * carries the `memoriesEnabled` switch, so gating it on that same flag would
 * hide the only way to turn memory back on. The tools' own gate is inside
 * {@link registerMemoryTools}. The section keeps the `settings.sections` slot
 * and `order: 70` it had under `app.settings`, so the page renders exactly where
 * it did — only its owner changed, which is what makes toggling this area take
 * the section with it.
 */
export const registerMemoryBuiltins = (host: Host): void => {
	registerMemoryTools(host);
	host.ui.register({
		id: "settings.section.memory",
		slot: "settings.sections",
		component: MemorySection,
		order: 70,
	});
};
