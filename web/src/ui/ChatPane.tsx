import type { ChatMessage } from "@lib/db";
import { useEffect, useRef, useState } from "react";
import { type ChatStatus, useChat } from "@/state/chat";
import Slot from "@/ui/slots/Slot";
import { useComponent } from "@/ui/slots/useContribution";

interface ChatPaneProps {
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
}

/** Distance from the bottom (px) that still counts as pinned to it. */
const PIN_THRESHOLD_PX = 40;

/**
 * The transcript region (spec §4's `chat.pane`): the scroll container and the
 * "jump to latest" affordance, whose body is the `chat.empty` region when the
 * conversation is empty and the `chat.messages` region otherwise. The scrolling
 * behaviour is the host's and stays here; only the rendered regions moved.
 */
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
					<Slot id="chat.empty" />
				) : (
					<Slot id="chat.messages" props={{ messages, status }} />
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

/**
 * The `chat.pane` built-in: reads the chat store and hands the pane its
 * messages and status, so the region is a contribution like any other and the
 * layout never holds the transcript's state.
 */
export function ChatPaneView() {
	const { messages, status } = useChat();
	return <ChatPane messages={messages} status={status} />;
}

/**
 * The empty-state region (`chat.empty`): the built-in is the "No messages yet"
 * placeholder. A plugin may add or replace it.
 */
export function EmptyState() {
	return (
		<div className="flex h-full items-center justify-center text-sm text-neutral-600">
			No messages yet
		</div>
	);
}

/**
 * The message-list region (`chat.messages`): the centred column of messages,
 * each rendered by whatever `ui.message` resolves to, followed by the
 * `chat.stream-status` region.
 */
export function MessageList({
	messages,
	status,
}: {
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
}) {
	const Message = useComponent("ui.message");
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
			{messages.map((message) => (
				<Message key={message.id} message={message} />
			))}
			<Slot id="chat.stream-status" props={{ status }} />
		</div>
	);
}

/**
 * The streaming-indicator region (`chat.stream-status`): renders the app's
 * "streaming…" line while a turn is in flight, nothing otherwise. A plugin can
 * add its own status affordance alongside.
 */
export function StreamStatus({ status }: { readonly status: ChatStatus }) {
	return status === "streaming" ? (
		<div className="text-left text-xs text-neutral-500">streaming…</div>
	) : null;
}
