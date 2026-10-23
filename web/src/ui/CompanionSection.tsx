import {
	COMPANION_PORT,
	companionStatus,
	pair,
	readStoredToken,
	unpair,
} from "@lib/companion";
import { isDesktop } from "@lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { hydrate } from "@/state/settings";
import {
	BUTTON,
	LABEL,
	SECTION_HEADING,
	SECTION_SUMMARY,
	SecretInput,
	Section,
} from "@/ui/kit";

interface CompanionInfo {
	readonly port: number;
	readonly token: string;
	readonly running: boolean;
}

/**
 * The "Local companion" settings section: status line, the port, a token field
 * with Pair/Unpair. On the desktop build, the app's own token is shown via
 * `companion_info` with a Rotate button.
 */
export function CompanionSection() {
	const [status, setStatus] = useState<"absent" | "unpaired" | "paired" | null>(
		null,
	);
	const [hasToken, setHasToken] = useState(false);
	const [token, setToken] = useState("");
	const [message, setMessage] = useState<string | null>(null);
	const [desktop, setDesktop] = useState<CompanionInfo | null>(null);
	const [pending, setPending] = useState(false);

	const refresh = useCallback((): void => {
		Effect.runFork(
			Effect.flatMap(companionStatus(), (next) =>
				Effect.flatMap(readStoredToken(), (stored) =>
					Effect.sync(() => {
						setStatus(next);
						setHasToken(stored !== null);
					}),
				),
			),
		);
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => {
		if (!isDesktop) return;
		Effect.runFork(
			Effect.tryPromise({
				try: () => invoke<CompanionInfo>("companion_info"),
				catch: (cause) => String(cause),
			}).pipe(
				Effect.tap((info) => Effect.sync(() => setDesktop(info))),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
			),
		);
	}, []);

	const doPair = (): void => {
		setPending(true);
		setMessage(null);
		Effect.runFork(
			pair(token).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						setMessage("Paired — settings now go through the desktop app.");
						setToken("");
						hydrate();
						refresh();
					}),
				),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setPending(false))),
			),
		);
	};

	const doUnpair = (): void => {
		setPending(true);
		setMessage(null);
		Effect.runFork(
			unpair().pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						setMessage(
							"Unpaired — this page keeps its own browser-local settings.",
						);
						hydrate();
						refresh();
					}),
				),
				Effect.ensuring(Effect.sync(() => setPending(false))),
			),
		);
	};

	const doRotate = (): void => {
		setPending(true);
		setMessage(null);
		Effect.runFork(
			Effect.tryPromise({
				try: () => invoke<{ readonly token: string }>("companion_rotate"),
				catch: (cause) => String(cause),
			}).pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						setToken(result.token);
						setMessage("Token rotated. Pair this page with the new token.");
					}),
				),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setPending(false))),
			),
		);
	};

	const statusLine = (() => {
		if (status === null) return "Checking…";
		if (status === "absent") {
			return hasToken
				? "The desktop app is not running — this page is using its own browser-local settings."
				: "Not running. Start the desktop app to use the local companion.";
		}
		if (status === "unpaired") return "Running, but this page is not paired.";
		return "Paired — settings and requests go through the desktop app.";
	})();

	return (
		<Section
			className="space-y-3"
			summaryClassName={SECTION_SUMMARY}
			heading={
				<h3
					id={SETTINGS_SECTIONS.companion.anchorId}
					className={SECTION_HEADING}
				>
					{SETTINGS_SECTIONS.companion.title}
				</h3>
			}
		>
			<p className="text-sm text-neutral-300">{statusLine}</p>
			<p className="text-xs text-neutral-500">
				Port {COMPANION_PORT}
				{isDesktop && desktop !== null
					? ` · listening: ${desktop.running ? "yes" : "no"}`
					: ""}
			</p>
			{isDesktop && desktop !== null ? (
				<div className={LABEL}>
					<label htmlFor="companion-app-token">This app's token</label>
					<SecretInput
						id="companion-app-token"
						value={desktop.token}
						readOnly
						shownByDefault
						placeholder="no token yet"
					/>
				</div>
			) : null}
			<div className={LABEL}>
				<label htmlFor="companion-token">Token</label>
				<SecretInput
					id="companion-token"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder="paste the companion's token"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{isDesktop ? (
					<button
						type="button"
						onClick={doRotate}
						disabled={pending}
						className={BUTTON}
					>
						{pending ? "Working…" : "Rotate"}
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={doPair}
							disabled={pending || token.trim() === ""}
							className={BUTTON}
						>
							{pending ? "Pairing…" : "Pair"}
						</button>
						<button
							type="button"
							onClick={doUnpair}
							disabled={pending}
							className={BUTTON}
						>
							Unpair
						</button>
					</>
				)}
			</div>
			{message !== null ? (
				<span className="text-sm text-neutral-400">{message}</span>
			) : null}
		</Section>
	);
}
