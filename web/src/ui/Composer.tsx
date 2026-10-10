import { isLocalEndpoint } from "@lib/providers/presets";
import type { AttachmentPart } from "@lib/providers/types";
import { Effect } from "effect";
import { type ChangeEvent, type KeyboardEvent, useRef, useState } from "react";
import { send, stop, useChat } from "@/state/chat";
import { useSettings } from "@/state/settings";

const BUTTON =
	"shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/** A pending attachment plus a stable key for React (and for removal). */
interface PendingAttachment {
	readonly id: string;
	readonly part: AttachmentPart;
}

/**
 * Read one file into an `AttachmentPart`. `FileReader` is a callback-based Web
 * API, so `Effect.callback` keeps it inside Effect without a raw `Promise`
 * (banned in `web/src` by the `no-new-promise` plugin).
 */
const readAttachment = (file: File): Effect.Effect<AttachmentPart, string> =>
	Effect.callback<AttachmentPart, string>((resume) => {
		const reader = new FileReader();
		reader.onload = () =>
			resume(
				Effect.succeed({
					kind: file.type.startsWith("image/") ? "image" : "file",
					name: file.name,
					dataUrl: String(reader.result ?? ""),
				}),
			);
		reader.onerror = () =>
			resume(Effect.fail(String(reader.error ?? "file read failed")));
		reader.readAsDataURL(file);
	});

export default function Composer() {
	const { status, hydrated } = useChat();
	const { providers, activeProviderId } = useSettings();
	const active = providers.find((provider) => provider.id === activeProviderId);
	const [text, setText] = useState("");
	const [parts, setParts] = useState<PendingAttachment[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const streaming = status === "streaming";
	const missingKey =
		!isLocalEndpoint(active?.baseUrl ?? "") &&
		(active?.apiKey ?? "").trim() === "";
	const missingBaseUrl = (active?.baseUrl ?? "").trim() === "";
	// Gated until hydration settles (empty list can otherwise hide a load in
	// flight), without a key or base URL, while streaming, and on an empty draft
	// with no attachments.
	const disabled =
		!hydrated ||
		missingKey ||
		missingBaseUrl ||
		streaming ||
		(text.trim() === "" && parts.length === 0);
	const attachDisabled = !hydrated || streaming;

	const submit = (): void => {
		if (disabled) return;
		send(
			text,
			parts.map((pending) => pending.part),
		);
		setText("");
		setParts([]);
		textareaRef.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	const onFilesSelected = (event: ChangeEvent<HTMLInputElement>): void => {
		const { files } = event.target;
		if (files !== null && files.length > 0) {
			Effect.runFork(
				Effect.forEach(Array.from(files), readAttachment).pipe(
					Effect.tap((read) =>
						Effect.sync(() =>
							setParts((prev) => [
								...prev,
								...read.map((part) => ({ id: crypto.randomUUID(), part })),
							]),
						),
					),
					Effect.catch((error) =>
						Effect.logError(`failed to read attachment: ${error}`),
					),
				),
			);
		}
		// Reset so re-selecting the same file fires `change` again.
		event.target.value = "";
	};

	const removePart = (id: string): void => {
		setParts((prev) => prev.filter((pending) => pending.id !== id));
	};

	return (
		<div className="border-t border-neutral-800 bg-neutral-950 px-4 py-3">
			<div className="mx-auto w-full max-w-3xl">
				{parts.length > 0 ? (
					<div className="mb-2 flex flex-wrap gap-1.5">
						{parts.map((pending) => (
							<span
								key={pending.id}
								className="flex max-w-[16rem] items-center gap-1.5 rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
							>
								{pending.part.kind === "image" ? (
									<img
										src={pending.part.dataUrl}
										alt={pending.part.name}
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
								<span className="truncate">{pending.part.name}</span>
								<button
									type="button"
									onClick={() => removePart(pending.id)}
									aria-label={`Remove ${pending.part.name}`}
									className="shrink-0 rounded text-neutral-500 hover:text-neutral-200"
								>
									<svg
										aria-hidden="true"
										viewBox="0 0 24 24"
										className="h-3.5 w-3.5"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M18 6 6 18M6 6l12 12" />
									</svg>
								</button>
							</span>
						))}
					</div>
				) : null}
				<div className="flex items-end gap-2">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept="image/*,application/pdf,text/*"
						onChange={onFilesSelected}
						className="hidden"
					/>
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						disabled={attachDisabled}
						aria-label="Attach files"
						className={`${BUTTON} border border-neutral-700 text-neutral-300 hover:bg-neutral-800`}
					>
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							className="h-5 w-5"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
						</svg>
					</button>
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
								: missingBaseUrl
									? "Add a base URL in settings to send"
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
		</div>
	);
}
