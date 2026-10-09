import type { Conversation } from "@lib/db";
import { useState } from "react";
import {
	deleteConversation,
	newConversation,
	renameConversation,
	selectConversation,
	useChat,
} from "@/state/chat";

export default function ConversationList() {
	const { conversations, activeId } = useChat();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	// The store only re-sorts at hydration; keep the sidebar newest-first here.
	const ordered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

	const startRename = (conversation: Conversation): void => {
		setEditingId(conversation.id);
		setDraft(conversation.title);
	};

	const commitRename = (): void => {
		if (editingId !== null) {
			const title = draft.trim();
			if (title !== "") renameConversation(editingId, title);
		}
		setEditingId(null);
	};

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
			<div className="flex items-center justify-between px-3 py-3">
				<span className="text-xs uppercase tracking-widest text-neutral-500">
					Chats
				</span>
				<button
					type="button"
					onClick={newConversation}
					className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
				>
					+ New
				</button>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{ordered.map((conversation) => {
					const active = conversation.id === activeId;
					const editing = conversation.id === editingId;
					return (
						<div
							key={conversation.id}
							className={`group mb-1 flex items-center gap-1 rounded-md px-2 py-2 ${active ? "bg-neutral-800" : "hover:bg-neutral-900"}`}
						>
							{editing ? (
								<input
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitRename();
										if (event.key === "Escape") setEditingId(null);
									}}
									onBlur={commitRename}
									className="min-w-0 flex-1 rounded border border-neutral-600 bg-neutral-900 px-1 py-0.5 text-left text-sm text-neutral-100 focus:outline-none"
								/>
							) : (
								<button
									type="button"
									onClick={() => selectConversation(conversation.id)}
									onDoubleClick={() => startRename(conversation)}
									title={conversation.title}
									className="min-w-0 flex-1 truncate text-left text-sm text-neutral-200"
								>
									{conversation.title}
								</button>
							)}
							{editing ? null : (
								<>
									<button
										type="button"
										onClick={() => startRename(conversation)}
										aria-label="Rename conversation"
										className="hidden shrink-0 rounded px-1 text-xs text-neutral-500 group-hover:block hover:text-neutral-200"
									>
										✎
									</button>
									<button
										type="button"
										onClick={() => deleteConversation(conversation.id)}
										aria-label="Delete conversation"
										className="hidden shrink-0 rounded px-1 text-xs text-neutral-500 group-hover:block hover:text-red-400"
									>
										✕
									</button>
								</>
							)}
						</div>
					);
				})}
			</div>
		</aside>
	);
}
