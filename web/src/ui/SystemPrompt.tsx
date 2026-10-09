import { useState } from "react";
import { setSystemPrompt, useChat } from "@/state/chat";

const BUTTON =
	"shrink-0 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800";

const TEXTAREA =
	"min-h-24 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

/**
 * Compact editor for the active conversation's system prompt, opened from the
 * chat header. The value is persisted with the conversation; blank sends none.
 */
export default function SystemPrompt() {
	const { systemPrompt } = useChat();
	const [open, setOpen] = useState(false);
	const hasPrompt = systemPrompt.trim() !== "";

	return (
		<div className="relative">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={BUTTON}
			>
				System{hasPrompt ? " •" : ""}
			</button>
			{open ? (
				<div className="absolute right-0 top-full z-10 mt-2 flex w-80 flex-col gap-1 rounded-md border border-neutral-700 bg-neutral-900 p-3 shadow-lg">
					<label
						htmlFor="system-prompt"
						className="text-xs uppercase tracking-widest text-neutral-500"
					>
						System prompt
					</label>
					<textarea
						id="system-prompt"
						rows={5}
						value={systemPrompt}
						onChange={(event) => setSystemPrompt(event.target.value)}
						placeholder="Instructions for this conversation…"
						className={TEXTAREA}
					/>
				</div>
			) : null}
		</div>
	);
}
