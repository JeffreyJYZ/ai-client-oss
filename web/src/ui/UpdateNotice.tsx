import { isDesktop } from "@lib/platform";
import { isNewer, latestVersion } from "@lib/updates";
import { getVersion } from "@tauri-apps/api/app";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import { LATEST_RELEASE_URL } from "@/constants/links";

/**
 * Dismissible "new release available" strip. Desktop only — the
 * website is continuously deployed, so a version notice is
 * meaningless there.
 */
export default function UpdateNotice() {
	const [latest, setLatest] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		if (!isDesktop) return;
		const check = Effect.gen(function* () {
			const running = yield* Effect.tryPromise({
				try: () => getVersion(),
				catch: () => "version read failed",
			});
			const newest = yield* latestVersion();
			return isNewer(newest, running) ? newest : null;
		});
		// A failed check (offline, rate limit, no releases) is silent:
		// the error channel is discarded, so there is no error UI and
		// the app is unaffected.
		Effect.runPromise(Effect.catch(check, () => Effect.succeed(null))).then(
			(newest) => {
				if (newest !== null) setLatest(newest);
			},
		);
	}, []);

	if (!isDesktop || dismissed || latest === null) return null;

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
					{latest}
				</a>{" "}
				is available.
			</p>
			<button
				type="button"
				onClick={() => setDismissed(true)}
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
		</div>
	);
}
