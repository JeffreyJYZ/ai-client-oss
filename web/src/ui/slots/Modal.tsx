import { resolveModal, useOverlay } from "@lib/plugins/notify";
import ConfirmButton from "@ui/ConfirmButton";
import { Button } from "@/ui/kit";

/**
 * The one modal surface (spec §5), contributed into `overlay.root` by
 * `builtin/overlay.ts`. Only the head of the queue renders, which is what makes
 * "at most one modal at a time" true even when a plugin asks twice: the second
 * request waits its turn rather than stacking on the first.
 *
 * The chrome is the app's own — the kit's `Button`, and `ConfirmButton` for the
 * affirmative (`ui/ConfirmButton`'s two-step arm/confirm with click-away and
 * Escape disarm, the shipped replacement for `window.confirm`, which is
 * platform-dependent in the Tauri webview). A plugin cannot bring its own
 * buttons and end up with a dialog that behaves unlike the app's.
 *
 * It traps nothing: no focus trap, no key listener, no backdrop that eats
 * keystrokes. The backdrop is a real button (click-away cancel), and Escape
 * disarm belongs to the confirm control, so a user can still type into the
 * composer behind an open dialog — the property Task 15's browser proof pins.
 */
export default function Modal() {
	const { modals } = useOverlay();
	const head = modals[0];
	if (head === undefined) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			{/* A real button, so click-away-to-cancel needs no a11y suppression.
			    `tabIndex={-1}` keeps it out of the tab ring: Tab reaches the
			    dialog's own controls instead of the full-screen backdrop first. */}
			<button
				type="button"
				tabIndex={-1}
				aria-label="Dismiss dialog"
				onClick={() => resolveModal(head.id, false)}
				className="absolute inset-0 cursor-default bg-black/60"
			/>
			{/* `key` is the request id, so a new head is a new dialog *instance*.
			    React would otherwise reuse this subtree, and a `ConfirmButton`
			    left armed on the previous request would arrive armed — one click
			    would confirm the next dialog, defeating the two-step guarantee
			    `ui/ConfirmButton` exists to provide. A head removed without a
			    pointer or blur event (a requestor's `ensuring` resolving a queued
			    head) is exactly that case. */}
			<div
				key={head.id}
				role="dialog"
				aria-label={head.title}
				className="relative w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
			>
				<h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-neutral-400">
					{head.title}
				</h2>
				<p className="mb-4 text-sm break-words whitespace-pre-wrap text-neutral-200">
					{head.text}
				</p>
				<div className="flex justify-end gap-2">
					{head.kind === "confirm" ? (
						<>
							<Button onClick={() => resolveModal(head.id, false)}>
								Cancel
							</Button>
							<ConfirmButton
								label="Confirm"
								confirmLabel="Confirm?"
								onConfirm={() => resolveModal(head.id, true)}
							/>
						</>
					) : (
						<Button onClick={() => resolveModal(head.id, false)}>Close</Button>
					)}
				</div>
			</div>
		</div>
	);
}
