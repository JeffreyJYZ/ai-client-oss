import { isDesktop, isMacOS } from "@lib/platform";
import { LATEST_RELEASE_URL } from "@/constants/links";
import { setSettings, useSettings } from "@/state/settings";
import { setView, useUIState } from "@/state/ui";
import Slot from "@/ui/slots/Slot";

/**
 * The app's own shell (spec §4), registered at `ui.root.layout` by
 * `lib/plugins/builtin/shell.ts`. It is the tree `ui/App.tsx` used to render,
 * with every named region replaced by a `<Slot>`: same elements, same classes,
 * same order, so with zero plugins the DOM is exactly the pre-task one.
 *
 * `Slot` adds no wrapper element of its own, which is what lets each region
 * here keep the container the old hardcoded child had (the `<main>` body holds
 * the chat pane and composer as direct children, the header's actions row is
 * still one `<div>`, and so on).
 *
 * The chrome pieces the shell registers as separate contributions live in this
 * file rather than in the registrar: the registrar is a `.ts` file and cannot
 * hold JSX, and these are the shell's UI, not its wiring.
 */
export default function DefaultLayout() {
	const { view } = useUIState();

	return (
		<div className="flex h-full w-full text-left">
			<Slot id="app.sidebar" />
			<main className="flex min-w-0 flex-1 flex-col bg-neutral-950">
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
					<Slot id="app.header.title" />
					<div className="flex items-center gap-2">
						<Slot id="app.header.actions" />
					</div>
				</header>
				<Slot id="app.notices" />
				<Slot id="app.banner" />
				{view === "settings" ? (
					<Slot id="settings.root" />
				) : (
					<>
						<Slot id="chat.pane" />
						<Slot id="composer.root" />
					</>
				)}
			</main>
		</div>
	);
}

/** The header title, registered at `app.header.title`. */
export function HeaderTitle() {
	return (
		<h1 className="min-w-0 truncate text-xs font-medium uppercase tracking-widest text-neutral-300">
			<span className="hidden sm:inline">Open Source AI Client</span>
			<span className="sm:hidden">OSS AI Client</span>
		</h1>
	);
}

/** The website's download link, registered at `app.header.actions`. */
export function DownloadLink() {
	if (isDesktop) return null;
	return (
		<a
			href={LATEST_RELEASE_URL}
			target="_blank"
			rel="noreferrer noopener"
			title="Download the desktop app"
			className="shrink-0 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
		>
			<span className="hidden sm:inline">Download desktop app</span>
			<span className="sm:hidden">Download</span>
		</a>
	);
}

/** The chat/settings view switch, registered at `app.header.actions`. */
export function SettingsToggle() {
	const { view } = useUIState();
	const showSettings = view === "settings";

	return (
		<button
			type="button"
			onClick={() => setView(showSettings ? "chat" : "settings")}
			className="shrink-0 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
		>
			{showSettings ? "Chat" : "Settings"}
		</button>
	);
}

/**
 * The unsigned-build note for macOS browsers, registered at `app.notices`:
 * absent on the desktop build, on non-macOS, or once dismissed.
 */
export function InstallNote() {
	const { dismissedInstallNote } = useSettings();

	if (isDesktop || !isMacOS || dismissedInstallNote) return null;

	return (
		<div className="flex shrink-0 items-start gap-3 border-b border-neutral-800 bg-neutral-900/60 px-4 py-1.5 text-[11px] break-words text-neutral-400">
			<p className="min-w-0 flex-1">
				The desktop build is unsigned — after installing, run{" "}
				<code className="text-neutral-300">
					{'xattr -dr com.apple.quarantine "/Applications/oss-ai-client.app"'}
				</code>{" "}
				once, or macOS will refuse to open it.
			</p>
			<button
				type="button"
				onClick={() => setSettings({ dismissedInstallNote: true })}
				aria-label="Dismiss the install note"
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
		</div>
	);
}
