import type { ChatMessage } from "@lib/db";
import { useEffect, useRef } from "react";
import type { ChatStatus } from "@/state/chat";
import Message from "@/ui/Message";

interface ChatPaneProps {
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
}

export default function ChatPane({ messages, status }: ChatPaneProps) {
	const bottomRef = useRef<HTMLDivElement>(null);

	// Follow the stream: every appended chunk rebuilds the `messages` array, so
	// this effect re-runs per chunk while streaming and pins the newest content.
	useEffect(() => {
		if (messages.length > 0 || status === "streaming") {
			bottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [messages, status]);

	return (
		<div className="flex-1 overflow-y-auto px-4 py-4">
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
						<div className="text-left text-xs text-neutral-500">streaming…</div>
					) : null}
				</div>
			)}
			<div ref={bottomRef} />
		</div>
	);
}
