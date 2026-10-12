import { isLocalEndpoint } from "@lib/providers/presets";
import type { AttachmentPart } from "@lib/providers/types";
import { Effect } from "effect";
import {
	type ChangeEvent,
	type ComponentType,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useRef,
	useState,
} from "react";
import { send, stop, useChat } from "@/state/chat";
import { useSettings } from "@/state/settings";
import { BUTTON_PLAIN } from "@/ui/kit";
import Slot from "@/ui/slots/Slot";
import { useComponent } from "@/ui/slots/useContribution";

/** A pending attachment plus a stable key for React (and for removal). */
interface PendingAttachment {
	readonly id: string;
	readonly part: AttachmentPart;
}

/**
 * What `<Composer>` hands its own contributions (spec §4). The composer keeps
 * its state (`text`, the draft's refs) and the handlers, and each toolbar or
 * actions contribution reads only what it renders. A `type` alias, not an
 * `interface`, on purpose: `Slot` types its props as `Record<string, unknown>`,
 * and only a type alias carries the implicit index signature that makes this
 * assignable to it.
 */
export type ComposerProps = {
	readonly text: string;
	readonly streaming: boolean;
	readonly disabled: boolean;
	readonly attachDisabled: boolean;
	readonly hydrated: boolean;
	readonly placeholder: string;
	readonly setText: (value: string) => void;
	readonly submit: () => void;
	readonly stop: () => void;
	readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	readonly onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
	readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
};

/**
 * Bind a contribution's own props contract to the registry's
 * `Record<string, unknown>` slot shape. `Slot` spreads exactly the object the
 * composer passes, so this cast is the one place the composer's internal
 * contract meets the plugin-facing prop type.
 */
const asComposerContribution = (
	component: (props: ComposerProps) => ReactNode,
): ComponentType<Record<string, unknown>> =>
	component as unknown as ComponentType<Record<string, unknown>>;

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

/**
 * The composer (spec §4): the stateful root of the `composer.root` region —
 * `Composer` is what `builtin/composer.ts` registers there under the
 * `ui.composer` component id. It owns the draft (`text`, `parts`, the text
 * area ref, the draft's file reader) and renders two regions, `composer.toolbar`
 * and `composer.actions`, passing state and handlers to their contributions as
 * props. The attachment chip row is rendered here, one chip per pending
 * attachment, each resolved through `useComponent("ui.attachment-chip")` so a
 * plugin can restyle or replace it.
 */
export default function Composer() {
	const { status, hydrated } = useChat();
	const { providers, activeProviderId } = useSettings();
	const active = providers.find((provider) => provider.id === activeProviderId);
	const [text, setText] = useState("");
	const [parts, setParts] = useState<PendingAttachment[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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

	const Chip = useComponent("ui.attachment-chip");

	const contributionProps: ComposerProps = {
		text,
		streaming,
		disabled,
		attachDisabled,
		hydrated,
		placeholder: missingKey
			? "Add an API key in settings to send"
			: missingBaseUrl
				? "Add a base URL in settings to send"
				: "Message… (Enter to send, Shift+Enter for a newline)",
		setText,
		submit,
		stop,
		onKeyDown,
		onFilesSelected,
		textareaRef,
	};

	return (
		<div className="border-t border-neutral-800 bg-neutral-950 px-4 py-3">
			<div className="mx-auto w-full max-w-3xl">
				{parts.length > 0 ? (
					<div className="mb-2 flex flex-wrap gap-1.5">
						{parts.map((pending) => (
							<Chip
								key={pending.id}
								part={pending.part}
								partId={pending.id}
								onRemove={removePart}
							/>
						))}
					</div>
				) : null}
				<div className="flex items-end gap-2">
					<Slot id="composer.toolbar" props={contributionProps} />
					<Slot id="composer.actions" props={contributionProps} />
				</div>
			</div>
		</div>
	);
}

/**
 * One pending attachment, registered at `composer.toolbar` as
 * `ui.attachment-chip` and resolved per chip by `<Composer>`. The registry
 * entry exists so `useComponent("ui.attachment-chip")` has a built-in to
 * resolve; when `Slot` renders that entry directly it carries no attachment
 * and draws nothing, which is why the missing `part` is the "no chip" case.
 * The remove button's label and classes are exactly the pre-task markup.
 */
export const AttachmentChip = (props: Record<string, unknown>): ReactNode => {
	const part = props.part as AttachmentPart | undefined;
	if (part === undefined) return null;
	const partId = String(props.partId ?? "");
	const remove = props.onRemove as ((id: string) => void) | undefined;

	return (
		<span className="flex max-w-[16rem] items-center gap-1.5 rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-300">
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
			<button
				type="button"
				onClick={() => remove?.(partId)}
				aria-label={`Remove ${part.name}`}
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
	);
};

/**
 * The hidden file input and the attach button, registered at `composer.toolbar`
 * (the input first, exactly as it renders today). They are one contribution
 * because the button owns the picker it opens: the input's ref is local, so a
 * replacement contribution is free to open its own.
 */
export const ComposerAttach = asComposerContribution((props) => {
	const fileInputRef = useRef<HTMLInputElement>(null);

	return (
		<>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				accept="image/*,application/pdf,text/*"
				onChange={props.onFilesSelected}
				className="hidden"
			/>
			<button
				type="button"
				onClick={() => fileInputRef.current?.click()}
				disabled={props.attachDisabled}
				aria-label="Attach files"
				className={`${BUTTON_PLAIN} border border-neutral-700 text-neutral-300 hover:bg-neutral-800`}
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
		</>
	);
});

/** The draft's textarea, registered at `composer.toolbar`. */
export const ComposerTextarea = asComposerContribution((props) => (
	<textarea
		ref={props.textareaRef}
		value={props.text}
		onChange={(event) => props.setText(event.target.value)}
		onKeyDown={props.onKeyDown}
		rows={2}
		disabled={!props.hydrated}
		placeholder={props.placeholder}
		className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none disabled:opacity-50"
	/>
));

/**
 * Stop, registered at `composer.actions`. It renders only while a turn is
 * streaming, and the Send contribution renders only when it is not, so exactly
 * one button occupies the row — the same swap the pre-task composer made.
 */
export const ComposerStop = asComposerContribution((props) =>
	props.streaming ? (
		<button
			type="button"
			onClick={props.stop}
			className={`${BUTTON_PLAIN} bg-red-600 text-white hover:bg-red-500`}
		>
			Stop
		</button>
	) : null,
);

/** Send, registered at `composer.actions` (the not-streaming half of the swap). */
export const ComposerSend = asComposerContribution((props) =>
	props.streaming ? null : (
		<button
			type="button"
			onClick={props.submit}
			disabled={props.disabled}
			className={`${BUTTON_PLAIN} bg-neutral-200 text-neutral-900 hover:bg-white`}
		>
			Send
		</button>
	),
);
