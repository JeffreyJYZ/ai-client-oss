import type { ChatMessage } from "@lib/db";
import Markdown from "@ui/Markdown";

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
				{message.reasoning !== undefined && message.reasoning !== "" ? (
					<details className="mb-2 rounded border border-neutral-700/60 bg-neutral-900/60 px-2 py-1.5">
						<summary className="cursor-pointer select-none text-[10px] uppercase tracking-widest text-neutral-500">
							Thinking…
						</summary>
						<p className="mt-1 whitespace-pre-wrap break-words text-xs italic text-neutral-500">
							{message.reasoning}
						</p>
					</details>
				) : null}
				{message.text === "" ? null : message.role === "assistant" ? (
					<Markdown text={message.text} />
				) : (
					// Only the model's answer is markdown; user input and error
					// strings stay literal, so `#` in pasted config is not a heading.
					<p className="whitespace-pre-wrap break-words text-sm">
						{message.text}
					</p>
				)}
				{message.parts !== undefined && message.parts.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{message.parts.map((part) => (
							<span
								key={part.dataUrl}
								className="flex max-w-[16rem] items-center gap-1.5 rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
							>
								{part.kind === "image" ? (
									<img
										src={part.dataUrl}
										alt={part.name}
										className="h-5 w-5 shrink-0 rounded object-cover"
									/>
								) : (
									<svg
										aria-hidden="true"
										viewBox="0 0 24 24"
										className="h-4 w-4 shrink-0 text-neutral-500"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
										<path d="M14 2v6h6" />
									</svg>
								)}
								<span className="truncate">{part.name}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
