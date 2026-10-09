import { type KeyboardEvent, useRef, useState } from "react";
import { send, stop, useChat } from "@/state/chat";
import { useSettings } from "@/state/settings";

const BUTTON =
	"shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export default function Composer() {
	const { status, hydrated } = useChat();
	const { apiKey } = useSettings();
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const streaming = status === "streaming";
	const missingKey = apiKey.trim() === "";
	// Gated until hydration settles (empty list can otherwise hide a load in
	// flight), without a key, while streaming, and on an empty draft.
	const disabled = !hydrated || missingKey || streaming || text.trim() === "";

	const submit = (): void => {
		if (disabled) return;
		send(text, []);
		setText("");
		textareaRef.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="border-t border-neutral-800 bg-neutral-950 px-4 py-3">
			<div className="mx-auto flex w-full max-w-3xl items-end gap-2">
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					rows={2}
					disabled={!hydrated}
					placeholder={
						missingKey
							? "Add an API key in settings to send"
							: "Message… (Enter to send, Shift+Enter for a newline)"
					}
					className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
				/>
				{streaming ? (
					<button
						type="button"
						onClick={stop}
						className={`${BUTTON} bg-red-600 text-white hover:bg-red-500`}
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={submit}
						disabled={disabled}
						className={`${BUTTON} bg-neutral-200 text-neutral-900 hover:bg-white`}
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
