import { isDesktop } from "@lib/platform";
import {
	discardUpdate,
	findUpdate,
	installUpdate,
	runningVersion,
	type UpdateOffer,
} from "@lib/updates";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";

export type UpdatePhase =
	| "idle"
	| "checking"
	| "current"
	| "available"
	| "downloading"
	| "failed";

export interface UpdateState {
	readonly phase: UpdatePhase;
	readonly running: string | null;
	readonly offer: UpdateOffer | null;
	readonly percent: number | null;
	readonly message: string | null;
}

/**
 * In-memory snapshot of the update flow. Both consumers — the
 * dismissible strip and the Settings Updates section — read this
 * one store, so a check, a download or a dismissal is visible to
 * both and neither owns the flow.
 */
let current: UpdateState = {
	phase: "idle",
	running: null,
	offer: null,
	percent: null,
	message: null,
};

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

/** Write-through to the snapshot; consumers re-render synchronously. */
const set = (patch: Partial<UpdateState>): void => {
	current = { ...current, ...patch };
	notify();
};

export const getUpdates = (): UpdateState => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const useUpdates = (): UpdateState =>
	useSyncExternalStore(subscribe, getUpdates);

/** What a check produced: an offer (or none) plus the running version. */
type CheckOutcome =
	| {
			readonly ok: true;
			readonly offer: UpdateOffer | null;
			readonly running: string | null;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * The running build's version, or `null` when it cannot be read —
 * the web build has no desktop shell to ask, and a version-read
 * failure says nothing the user can act on, so it folds to `null`.
 */
const runningVersionOrNull = (): Effect.Effect<string | null> =>
	isDesktop
		? Effect.catch(runningVersion(), () => Effect.succeed(null))
		: Effect.succeed(null);

/**
 * Check for a newer release. A second call while one is in flight
 * (checking or downloading) is a no-op, so a mounting section
 * never starts a parallel check beside the strip's own.
 *
 * Re-checking replaces the previous offer; its Rust-side updater
 * handle is handed back first — the same release a dismissal
 * performs — so a live handle is never dropped on the floor.
 */
export const checkForUpdates = (): void => {
	if (current.phase === "checking" || current.phase === "downloading") return;
	const previous = current.offer;
	if (previous?.kind === "updater") {
		Effect.runFork(discardUpdate(previous.update));
	}
	set({ phase: "checking", message: null, percent: null });
	Effect.runPromise(
		Effect.catch(
			Effect.flatMap(runningVersionOrNull(), (running) =>
				Effect.map(
					findUpdate(),
					(offer): CheckOutcome => ({
						ok: true,
						offer,
						running,
					}),
				),
			),
			(message): Effect.Effect<CheckOutcome> =>
				Effect.succeed({ ok: false, message }),
		),
	).then((outcome) => {
		if (!outcome.ok) {
			set({
				phase: "failed",
				offer: null,
				percent: null,
				message: outcome.message,
			});
			return;
		}
		set({
			phase: outcome.offer === null ? "current" : "available",
			offer: outcome.offer,
			running: outcome.running,
			percent: null,
			message: null,
		});
	});
};

/**
 * Install the offered update: download (reporting progress — `null`
 * while the total size is unknown) then relaunch. Only an updater
 * offer carries a handle that can install; anything else is a
 * no-op. Every failure lands in `message` with phase `failed`,
 * never a thrown error — and since the relaunch is the last step,
 * a settled effect that failed means the download or restart did
 * not complete.
 */
export const installNow = (): void => {
	const { phase, offer } = current;
	if (phase !== "available" || offer === null || offer.kind !== "updater")
		return;
	set({ phase: "downloading", percent: null });
	Effect.runPromise(
		Effect.catch(
			installUpdate(offer.update, (percent) => set({ percent })),
			(message): Effect.Effect<void> =>
				Effect.sync(() => set({ phase: "failed", percent: null, message })),
		),
	);
};

/**
 * Back to `idle`, handing a live updater handle back to Rust. The
 * strip's dismiss calls this: a closed handle cannot be installed
 * from later, so the next consumer to mount runs a fresh check and
 * gets a handle that can actually install.
 */
export const releaseOffer = (): void => {
	const { offer } = current;
	if (offer?.kind === "updater") {
		Effect.runFork(discardUpdate(offer.update));
	}
	set({ phase: "idle", offer: null, percent: null, message: null });
};
