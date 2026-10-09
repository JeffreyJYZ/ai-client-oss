import type { ChatMessage } from "@lib/db";
import { useEffect, useRef, useState } from "react";
import type { ChatStatus } from "@/state/chat";
import Message from "@/ui/Message";

interface ChatPaneProps {
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
}

/** Distance from the bottom (px) that still counts as pinned to it. */
const PIN_THRESHOLD_PX = 40;

export default function ChatPane({ messages, status }: ChatPaneProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	// Follow the stream only while the user is pinned to the bottom; once they
	// scroll up to read, leave the view where it is instead of yanking it back.
	useEffect(() => {
		if (pinned && (messages.length > 0 || status === "streaming")) {
			bottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [messages, status, pinned]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (el === null) {
			return;
		}
		setPinned(
			el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX,
		);
	};

	const jumpToLatest = () => {
		setPinned(true);
		bottomRef.current?.scrollIntoView({ block: "end" });
	};

	return (
		<div className="relative flex-1 overflow-hidden">
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="h-full overflow-y-auto px-4 py-4"
			>
				{messages.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-neutral-600">
						No messages yet
					</div>
				) : (
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
						{messages.map((message) => (
							<Message key={message.id} message={message} />
						))}
						{status === "streaming" ? (
							<div className="text-left text-xs text-neutral-500">
								streaming…
							</div>
						) : null}
					</div>
				)}
				<div ref={bottomRef} />
			</div>
			{pinned ? null : (
				// Rendered as an overlay over the scroller, not inside it: an
				// `absolute` child of the scroll container anchors to the content
				// box and scrolls out of view, so it vanishes exactly when needed.
				<button
					type="button"
					onClick={jumpToLatest}
					className="absolute bottom-4 right-6 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 shadow-sm hover:bg-neutral-800"
				>
					Jump to latest
				</button>
			)}
		</div>
	);
}
