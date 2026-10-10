import { isDesktop } from "@lib/platform";
import {
	discardUpdate,
	findUpdate,
	installUpdate,
	type UpdateOffer,
} from "@lib/updates";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { LATEST_RELEASE_URL } from "@/constants/links";
import { setSettings, useSettings } from "@/state/settings";

/** What the in-app installer is doing, if it was ever started. */
type InstallState =
	| { readonly phase: "idle" }
	| { readonly phase: "downloading"; readonly percent: number | null }
	| { readonly phase: "failed"; readonly message: string };

/**
 * Dismissible "new release available" strip. Desktop only — the
 * website is continuously deployed, so a version notice is
 * meaningless there.
 *
 * When the Tauri updater is registered the strip becomes the install
 * flow: download (with progress) then relaunch. Builds without it get
 * the old link-only notice, and a failed install falls back to the
 * same release link.
 */
export default function UpdateNotice() {
	const [offer, setOffer] = useState<UpdateOffer | null>(null);
	const [install, setInstall] = useState<InstallState>({ phase: "idle" });
	const { dismissedUpdateVersion } = useSettings();

	useEffect(() => {
		if (!isDesktop) return;
		// A failed check (offline, rate limit, no releases, an endpoint that
		// predates the updater) is silent: the error channel is discarded, so
		// there is no error UI and the app is unaffected.
		Effect.runPromise(
			Effect.catch(findUpdate(), () => Effect.succeed(null)),
		).then((found) => {
			setOffer(found);
		});
	}, []);

	if (!isDesktop || offer === null || offer.version === dismissedUpdateVersion)
		return null;

	const dismiss = () => {
		setSettings({ dismissedUpdateVersion: offer.version });
		// The updater handle is only useful while it is on screen; releasing it
		// keeps one Rust-side resource from living on after the dismissal.
		if (offer.kind === "updater") Effect.runFork(discardUpdate(offer.update));
	};

	const startInstall = () => {
		if (offer.kind !== "updater" || install.phase === "downloading") return;
		setInstall({ phase: "downloading", percent: null });
		Effect.runPromise(
			Effect.catch(
				installUpdate(offer.update, (percent) =>
					setInstall({ phase: "downloading", percent }),
				),
				(message) =>
					Effect.sync(() => setInstall({ phase: "failed", message })),
			),
		);
	};

	const busy = install.phase === "downloading";

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
				is available.
				{install.phase === "failed"
					? ` Updating failed (${install.message}) — install it from the release page instead.`
					: null}
			</p>
			{offer.kind === "updater" && install.phase !== "failed" ? (
				<button
					type="button"
					onClick={startInstall}
					disabled={busy}
					className="shrink-0 rounded px-1 text-neutral-300 hover:text-neutral-100 disabled:text-neutral-500"
				>
					{busy
						? install.percent === null
							? "Updating…"
							: `Updating ${install.percent}%`
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
