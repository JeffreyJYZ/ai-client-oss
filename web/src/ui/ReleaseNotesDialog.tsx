import { dismissReleaseNotes, useReleaseNotes } from "@/state/releaseNotes";
import { Button } from "@/ui/kit";
import Markdown from "@/ui/Markdown";

/**
 * The app's own release notes: the body of the GitHub release for the
 * running version, rendered with the app's Markdown component.
 *
 * The chrome is the app's modal chrome — the same backdrop, panel and Close
 * button `ui/slots/Modal.tsx` uses — so the notes look like every other
 * dialog in the app. The body is markdown rather than a plain string, so it
 * gets a wider, scrollable panel of its own.
 *
 * It renders nothing until there are notes to show, which keeps the overlay
 * region empty exactly as it is when the app has nothing to say.
 */
export default function ReleaseNotesDialog() {
	const { status, version, body } = useReleaseNotes();
	if (status !== "ready" || version === null || body === null) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			{/* A real button, so click-away-to-dismiss needs no a11y suppression —
			    the same affordance the plugin modal offers. */}
			<button
				type="button"
				tabIndex={-1}
				aria-label="Dismiss dialog"
				onClick={dismissReleaseNotes}
				className="absolute inset-0 cursor-default bg-black/60"
			/>
			<div
				role="dialog"
				aria-label={`Release notes ${version}`}
				className="relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
			>
				<h2 className="mb-2 text-xs font-medium uppercase tracking-widest text-neutral-400">
					Release notes {version}
				</h2>
				<div className="mb-4 min-h-0 flex-1 overflow-auto text-sm text-neutral-200">
					<Markdown text={body} />
				</div>
				<div className="flex justify-end gap-2">
					<Button onClick={dismissReleaseNotes}>Close</Button>
				</div>
			</div>
		</div>
	);
}
