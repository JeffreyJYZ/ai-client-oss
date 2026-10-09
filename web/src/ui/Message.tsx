import type { ChatMessage } from "@lib/db";

interface MessageProps {
	readonly message: ChatMessage;
}

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
	user: "you",
	assistant: "assistant",
	error: "error",
};

const ROLE_STYLE: Record<ChatMessage["role"], string> = {
	user: "bg-blue-600/20 text-neutral-100",
	assistant: "bg-neutral-800 text-neutral-100",
	error: "bg-red-900/30 text-red-200",
};

export default function Message({ message }: MessageProps) {
	const isUser = message.role === "user";
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[80%] rounded-lg px-3 py-2 text-left ${ROLE_STYLE[message.role]}`}
			>
				<div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-400">
					{ROLE_LABEL[message.role]}
				</div>
				{message.text === "" ? null : (
					<p className="whitespace-pre-wrap break-words text-sm">
						{message.text}
					</p>
				)}
				{message.parts !== undefined && message.parts.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1">
						{message.parts.map((part) => (
							<span
								key={part.dataUrl}
								className="rounded border border-neutral-600 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-300"
							>
								{part.kind === "image" ? "image" : "file"}: {part.name}
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
