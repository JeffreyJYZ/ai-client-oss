import { dismissToast, type Tone, useOverlay } from "@lib/plugins/notify";

/**
 * Tone → the app's own palette. A plugin toast is drawn by this component, not
 * by the plugin, so it cannot arrive in chrome that looks foreign; the tones
 * reuse the app's neutral/red/emerald utilities rather than new tokens.
 */
const TONE: Record<Tone, string> = {
	info: "border-neutral-700 bg-neutral-900 text-neutral-200",
	success: "border-emerald-500/50 bg-emerald-950/70 text-emerald-100",
	error: "border-red-500/60 bg-red-950/70 text-red-200",
};

/**
 * The toast stack (spec §5), contributed into `overlay.root` by
 * `builtin/overlay.ts`. Every toast the notification service has queued renders
 * here; with nothing queued the component returns `null`, so the overlay region
 * is DOM-inert while idle (the Phase-1 property the slot preserves).
 *
 * The container ignores pointer events and each toast re-enables them, so the
 * stack itself never swallows a click the user meant for the app underneath.
 * There is no key handling here at all: the surface must not trap keys it has
 * no business trapping.
 */
export default function Toasts() {
	const { toasts } = useOverlay();
	if (toasts.length === 0) return null;

	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
			{toasts.map((entry) => (
				<div
					key={entry.id}
					role="status"
					className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg ${TONE[entry.tone]}`}
				>
					<p className="min-w-0 flex-1 break-words">{entry.text}</p>
					<button
						type="button"
						aria-label="Dismiss notification"
						onClick={() => dismissToast(entry.id)}
						className="shrink-0 rounded text-neutral-400 hover:text-neutral-100"
					>
						×
					</button>
				</div>
			))}
		</div>
	);
}
