import type { Host } from "@lib/plugins/sdk";
import { Effect, Option } from "effect";
import { useEffect, useState } from "react";

/**
 * sidebar-notes — a chrome slot with real persistence (spec §4/§5).
 *
 * What it teaches:
 * - **`app.sidebar`** is a slot a plugin can contribute to; the host renders
 *   every contribution, so this panel appears alongside the built-in list;
 * - **`host.storage`** as a real store: `get`/`set`/`delete`/`keys` are all
 *   used, not just get/set — `delete` clears an empty conversation's entry and
 *   `keys` reports how many conversations carry notes;
 * - **`host.notify.confirm`** gates a destructive action (delete) and is run
 *   through the Effect the host returns, not through a runner that does not
 *   exist;
 * - **`host.on("conversation-changed")`** re-reads the note bound to the newly
 *   active conversation, so switching chats swaps the panel's contents.
 *
 * What it deliberately does not do: it stores plain strings, not rich text; it
 * keeps one list per conversation under a `notes:<id>` key rather than a single
 * shared document; and it does not sync across tabs.
 */
const notesKey = (conversationId: string): string => `notes:${conversationId}`;

interface Note {
	readonly id: number;
	readonly text: string;
}

const readNotes = (host: Host, conversationId: string): Note[] => {
	const stored = Effect.runSync(host.storage.get(notesKey(conversationId)));
	if (!Option.isSome(stored) || !Array.isArray(stored.value)) return [];
	return stored.value
		.filter(
			(item): item is Note =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as { text?: unknown }).text === "string" &&
				typeof (item as { id?: unknown }).id === "number",
		)
		.map((item) => ({ id: item.id, text: item.text }));
};

const persistNotes = (
	host: Host,
	conversationId: string,
	notes: Note[],
): void => {
	if (notes.length === 0) {
		Effect.runSync(host.storage.delete(notesKey(conversationId)));
	} else {
		Effect.runSync(host.storage.set(notesKey(conversationId), notes));
	}
};

export default {
	setup(host: Host) {
		host.log.info("sidebar-notes loaded");

		const SidebarNotes = function SidebarNotes() {
			const [activeId, setActiveId] = useState(host.chat.snapshot().activeId);
			const [notes, setNotes] = useState<Note[]>(() =>
				readNotes(host, host.chat.snapshot().activeId),
			);
			const [draft, setDraft] = useState("");
			const [storedKeyCount, setStoredKeyCount] = useState(0);

			useEffect(() => {
				const refreshKeyCount = (): void => {
					const keys = Effect.runSync(host.storage.keys());
					setStoredKeyCount(keys.length);
				};
				refreshKeyCount();
				const handle = host.on("conversation-changed", (payload) => {
					const nextId =
						(payload as { readonly activeId?: string } | null)?.activeId ??
						host.chat.snapshot().activeId;
					setActiveId(nextId);
					setNotes(readNotes(host, nextId));
					refreshKeyCount();
				});
				return () => handle.dispose();
			}, []);

			const add = (): void => {
				const text = draft.trim();
				if (text === "") return;
				const next = [...notes, { id: Date.now(), text }];
				persistNotes(host, activeId, next);
				setNotes(next);
				setDraft("");
			};

			const remove = (id: number): void => {
				Effect.runFork(
					host.notify.confirm({ text: "Delete this note?" }).pipe(
						Effect.flatMap((ok) =>
							ok
								? Effect.sync(() => {
										const next = notes.filter(
											(candidate) => candidate.id !== id,
										);
										persistNotes(host, activeId, next);
										setNotes(next);
									})
								: Effect.void,
						),
					),
				);
			};

			const { Panel, Button, INPUT } = host.ui.kit;
			return (
				<Panel>
					<div className="flex flex-col gap-2 p-2">
						<div className="text-xs uppercase tracking-widest text-neutral-500">
							Notes
						</div>
						<div className="text-xs text-neutral-400">
							for {activeId === "" ? "no conversation" : activeId}
						</div>
						<div className="text-xs text-neutral-500">
							stored keys: {storedKeyCount}
						</div>
						<div className="flex gap-1">
							<input
								className={INPUT}
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") add();
								}}
								placeholder="Add a note"
							/>
							<Button onClick={add}>Add</Button>
						</div>
						<ul className="flex flex-col gap-1">
							{notes.map((note) => (
								<li
									key={note.id}
									className="flex items-center justify-between gap-2 text-sm"
								>
									<span className="truncate">{note.text}</span>
									<Button onClick={() => remove(note.id)}>Delete</Button>
								</li>
							))}
						</ul>
					</div>
				</Panel>
			);
		};

		host.ui.register({
			id: "example.sidebar-notes.panel",
			slot: "app.sidebar",
			component: SidebarNotes,
		});

		return {
			dispose: () => host.log.info("sidebar-notes unloaded"),
		};
	},
};
