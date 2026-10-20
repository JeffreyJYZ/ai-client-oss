import { HostServices } from "@lib/plugins/host";
import { runtime } from "@lib/plugins/runtime";
import { notesForVersion, shouldShowReleaseNotes } from "@lib/releaseNotes";
import { releaseNotesFor } from "@lib/updates";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { getSettings, setSettings } from "@/state/settings";

/**
 * The release notes of the running build.
 *
 * The notes live in the GitHub release whose tag carries the running version
 * (`desktop-v<version>`), so they describe exactly the build the user is on.
 * This store holds what the app shows of them:
 *
 * - `idle` — nothing fetched (or nothing left to show);
 * - `loading` — a read is in flight;
 * - `ready` — the notes are here and the modal shows them.
 *
 * A read that fails — offline, no such release, rate limited, a payload that
 * is not a release — shows nothing and records nothing, so the next launch
 * tries again.
 */
export type ReleaseNotesStatus = "idle" | "loading" | "ready";

export interface ReleaseNotesState {
	readonly status: ReleaseNotesStatus;
	/** The version the notes belong to; `null` unless they are shown. */
	readonly version: string | null;
	/** The notes themselves, as GitHub-flavoured markdown. */
	readonly body: string | null;
}

let current: ReleaseNotesState = {
	status: "idle",
	version: null,
	body: null,
};

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

const set = (patch: Partial<ReleaseNotesState>): void => {
	current = { ...current, ...patch };
	notify();
};

export const getReleaseNotes = (): ReleaseNotesState => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const useReleaseNotes = (): ReleaseNotesState =>
	useSyncExternalStore(subscribe, getReleaseNotes);

/**
 * The version this build reports for itself.
 *
 * Read through the host's services rather than re-derived: the host resolves
 * it once at boot — the desktop shell's version, or the build's own on the
 * web — and the plugin host, the update check and these notes all read that
 * one value.
 */
const runningVersion = (): Effect.Effect<string, never, HostServices> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.succeed(services.version.app),
	);

/** Nothing to show: the read failed, or the release carries no notes. */
const clear = (): Effect.Effect<void, never> =>
	Effect.sync(() => {
		set({ status: "idle", version: null, body: null });
	});

/** Read the notes of one version and hold them ready to be shown. */
const load = (version: string): Effect.Effect<void, never> =>
	Effect.flatMap(
		Effect.catch(releaseNotesFor(version), () =>
			Effect.succeed<string | null>(null),
		),
		(body) =>
			Effect.sync(() => {
				// One version's notes, never the stacked history a release body may
				// carry: the popup describes the build the user just moved to.
				const notes =
					body === null || body.trim() === ""
						? null
						: notesForVersion(body, version);
				if (notes === null || notes === "") {
					set({ status: "idle", version: null, body: null });
					return;
				}
				set({ status: "ready", version, body: notes });
			}),
	);

/**
 * The boot check: show the running version's notes if they have not been
 * dismissed yet.
 *
 * Called once the settings have hydrated — before that the dismissed version
 * is still the default, and the notes would be shown to a user who already
 * dismissed them.
 */
export const checkForReleaseNotes = (): void => {
	if (current.status !== "idle") return;
	set({ status: "loading", version: null, body: null });
	const dismissed = getSettings().dismissedReleaseNotesVersion;
	runtime
		.runPromise(
			Effect.flatMap(runningVersion(), (version) =>
				shouldShowReleaseNotes(dismissed, version) ? load(version) : clear(),
			).pipe(
				Effect.catchCause(() =>
					Effect.sync(() => {
						set({ status: "idle", version: null, body: null });
					}),
				),
			),
		)
		.catch(() => {
			set({ status: "idle", version: null, body: null });
		});
};

/**
 * Show the notes of the running version on request (the Settings control),
 * whether or not they have been dismissed before.
 */
export const openReleaseNotes = (): void => {
	if (current.status !== "idle") return;
	set({ status: "loading", version: null, body: null });
	runtime
		.runPromise(
			Effect.flatMap(runningVersion(), (version) => load(version)).pipe(
				Effect.catchCause(() =>
					Effect.sync(() => {
						set({ status: "idle", version: null, body: null });
					}),
				),
			),
		)
		.catch(() => {
			set({ status: "idle", version: null, body: null });
		});
};

/**
 * Close the notes and remember the version, so the same release's notes do
 * not come back on the next launch. Nothing is recorded while the notes were
 * never shown, so a failed read leaves the version unseen.
 */
export const dismissReleaseNotes = (): void => {
	const { version } = current;
	if (version !== null) {
		setSettings({ dismissedReleaseNotesVersion: version });
	}
	set({ status: "idle", version: null, body: null });
};
