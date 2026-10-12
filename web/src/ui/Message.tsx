import type { ChatMessage } from "@lib/db";
import { type DisplayMarker, interleaveMarkers } from "@lib/text";
import Markdown from "@ui/Markdown";
import Slot from "@/ui/slots/Slot";
import { useComponent } from "@/ui/slots/useContribution";

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

/**
 * The assistant body's markdown renderer (spec §4's `ui.markdown`): the
 * built-in is the app's own `Markdown`, and a plugin can replace it without
 * touching the message chrome. Split out from {@link MarkerBody} so a markdown
 * override restyles code blocks and prose while the marker interleave stays the
 * host's.
 */
export function MarkdownBody({ text }: { readonly text: string }) {
	return <Markdown text={text} />;
}

/**
 * The assistant body (`ui.marker`): the model's answer with its display-only
 * markers interleaved at the offsets they were recorded at, rendered through
 * whatever `ui.markdown` resolves to. Splitting the marker-aware body from the
 * bare markdown renderer is what lets a plugin replace either half; the default
 * pair renders exactly today's `<Markdown text={interleaveMarkers(...)} />`.
 */
export function MarkerBody({
	text,
	markers,
}: {
	readonly text: string;
	readonly markers: readonly DisplayMarker[];
}) {
	const Body = useComponent("ui.markdown");
	return <Body text={interleaveMarkers(text, markers)} />;
}

/**
 * The collapsible reasoning block (`ui.reasoning`): a plugin can replace how a
 * model's thinking is shown without replacing the message. Unchanged markup
 * from the pre-migration `Message`.
 */
export function ReasoningBlock({ reasoning }: { readonly reasoning: string }) {
	return (
		<details className="mb-2 rounded border border-neutral-700/60 bg-neutral-900/60 px-2 py-1.5">
			<summary className="cursor-pointer select-none text-[10px] uppercase tracking-widest text-neutral-500">
				Thinking… {reasoning.length.toLocaleString()} chars
			</summary>
			<p className="mt-1 whitespace-pre-wrap break-words text-xs italic text-neutral-500">
				{reasoning}
			</p>
		</details>
	);
}

/**
 * One transcript message (spec §4's `ui.message` built-in): the role label, the
 * reasoning block, the markdown or literal body, the attachment chips, and —
 * after the chips — the `chat.message.actions` region, which contributes
 * nothing until a plugin targets it. The body and reasoning render through
 * their own overridable components, so the whole message can be replaced
 * (`ui.message`) or just its halves.
 */
export default function Message({ message }: MessageProps) {
	const isUser = message.role === "user";
	const Body = useComponent("ui.marker");
	const Reasoning = useComponent("ui.reasoning");
	// A marker-only message (a tool call with no text around it) still
	// renders: the marker is its whole visible content.
	const empty = message.text === "" && message.markers.length === 0;
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[80%] rounded-lg px-3 py-2 text-left ${ROLE_STYLE[message.role]}`}
			>
				<div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-400">
					{ROLE_LABEL[message.role]}
				</div>
				{message.reasoning !== undefined && message.reasoning !== "" ? (
					<Reasoning reasoning={message.reasoning} />
				) : null}
				{empty ? null : message.role === "assistant" ? (
					// Markers are display-only: interleaved with the
					// answer text for the transcript, never part of it.
					<Body text={message.text} markers={message.markers} />
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
				{/* Per-message plugin region: after the attachment chips, empty
				    until a plugin registers into it. */}
				<Slot id="chat.message.actions" props={{ message }} />
			</div>
		</div>
	);
}
