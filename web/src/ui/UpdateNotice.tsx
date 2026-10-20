import { isDesktop } from "@lib/platform";
import { offerClause } from "@lib/updates";
import { useEffect } from "react";
import { LATEST_RELEASE_URL } from "@/constants/links";
import { setSettings, useSettings } from "@/state/settings";
import {
	checkForUpdates,
	installNow,
	releaseOffer,
	useUpdates,
} from "@/state/updates";

/**
 * Dismissible "new release available" strip. Desktop only — the
 * website is continuously deployed, so a version notice is
 * meaningless there.
 *
 * The check/install flow lives in `state/updates` — the same store
 * the Settings Updates section reads — so this component only
 * renders it. When the Tauri updater is registered the strip
 * becomes the install flow: download (with progress) then relaunch.
 * Builds without it get the link-only notice, and a failed install
 * falls back to the same release link.
 */
export default function UpdateNotice() {
	const { phase, offer, percent, message } = useUpdates();
	const { dismissedUpdateVersion } = useSettings();

	useEffect(() => {
		if (!isDesktop) return;
		// A failed check (offline, rate limit, no releases, an endpoint
		// that predates the updater) is silent: the store folds the
		// error into `message`, and with no offer the strip stays
		// absent and the app is unaffected.
		checkForUpdates();
	}, []);

	if (!isDesktop || offer === null || offer.version === dismissedUpdateVersion)
		return null;

	const busy = phase === "downloading";

	const dismiss = () => {
		setSettings({ dismissedUpdateVersion: offer.version });
		// Dismissing closes the updater handle, and a closed handle
		// cannot be installed from later — so release the offer and
		// leave the store "idle": reopening Settings then runs a fresh
		// check and gets a live handle to install from.
		releaseOffer();
	};

	return (
		<div className="flex shrink-0 items-start gap-3 border-b border-neutral-800 bg-neutral-900/60 px-4 py-1.5 text-[11px] break-words text-neutral-400">
			<p className="min-w-0 flex-1">
				Version{" "}
				<a
					href={LATEST_RELEASE_URL}
					target="_blank"
					rel="noreferrer noopener"
					className="text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
				>
					{offer.version}
				</a>{" "}
				{offerClause(offer)}
				{phase === "failed" && message !== null
					? ` Updating failed (${message}) — install it from the release page instead.`
					: null}
			</p>
			{offer.kind === "updater" && phase !== "failed" ? (
				<button
					type="button"
					onClick={installNow}
					disabled={busy}
					className="shrink-0 rounded px-1 text-neutral-300 hover:text-neutral-100 disabled:text-neutral-500"
				>
					{busy
						? percent === null
							? "Updating…"
							: `Updating ${percent}%`
						: "Update now"}
				</button>
			) : null}
			{busy ? null : (
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss the update notice"
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
			)}
		</div>
	);
}
