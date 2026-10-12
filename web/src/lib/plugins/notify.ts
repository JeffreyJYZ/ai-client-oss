import { PluginFault } from "@lib/plugins/errors";
import { runtime } from "@lib/plugins/runtime";
import {
	Deferred,
	Duration,
	Effect,
	Option,
	Scope,
	type Stream,
	SubscriptionRef,
} from "effect";
import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The notification surface (spec §5): toasts, banners, confirms and modals,
 * presented by the host's own components in `overlay.root` rather than by
 * plugin chrome, so a plugin dialog looks like the app. The two halves are
 * deliberate:
 *
 * - The **presentation state** is one module-level store (`SubscriptionRef` as
 *   the Effect-facing value, a referentially-stable module snapshot as the
 *   React projection, both written by the same synchronous `commit`). React
 *   reads it with `useSyncExternalStore`, exactly like `ui/slots` and
 *   `lib/plugins/commands.ts`; the two cannot disagree because nothing else
 *   writes either.
 * - The **primitives are Effects**, so a toast's `ttl` fibre is owned by the
 *   pushing plugin's `Scope` (spec §3: `Scope` is the lifetime). Unloading the
 *   plugin closes that scope, and the toast goes with it — that is the load-
 *   bearing property, not a nicety.
 *
 * One `Deferred` per `confirm` request, resolved by the modal's own button (or
 * by the requestor going away), is what makes a second confirm *queue* behind
 * the open one instead of replacing it: the queue is the state, and each
 * requestor awaits its own answer. `Effect.ensuring` on the await means a
 * cancelled or unloaded requestor removes its request, so the UI can never be
 * left holding a modal nothing will ever complete.
 */

/** How long a toast stays up when the caller does not give a `ttl`. */
export const DEFAULT_TOAST_TTL = 5000;

/** The tones a notification can carry; the components map them to classes. */
export const tones = ["info", "success", "error"] as const;

/** The zod schema for a tone — the single declaration of the union (spec §1). */
export const toneSchema = z.enum(tones);

/** One notification tone. */
export type Tone = z.infer<typeof toneSchema>;

/** A transient notification (spec §5). */
export const toastSchema = z.object({
	text: z.string(),
	tone: toneSchema.default("info"),
	/** Milliseconds before it dismisses itself; the default is used when absent. */
	ttl: z.number().nonnegative().optional(),
});

/** The arguments of {@link toast}; `tone` and `ttl` are optional. */
export type ToastOptions = z.input<typeof toastSchema>;

/** A sticky notification: a toast that never expires on its own. */
export const bannerSchema = z.object({
	text: z.string(),
	tone: toneSchema.default("info"),
});

/** The arguments of {@link banner}. */
export type BannerOptions = z.input<typeof bannerSchema>;

/** A modal yes/no question (spec §5). */
export const confirmSchema = z.object({
	text: z.string(),
	title: z.string().optional(),
});

/** The arguments of {@link confirm}. */
export type ConfirmOptions = z.input<typeof confirmSchema>;

/** A modal that displays a title and a body until it is dismissed. */
export const modalSchema = z.object({
	title: z.string(),
	content: z.string(),
});

/** The arguments of {@link modal}. */
export type ModalOptions = z.input<typeof modalSchema>;

/** One entry in the toast stack. */
export interface Toast {
	readonly id: number;
	readonly text: string;
	readonly tone: Tone;
	/** Sticky entries never expire; only a dismiss or an unload removes them. */
	readonly sticky: boolean;
}

/** One entry in the modal queue; only the head is rendered. */
export interface ModalRequest {
	readonly id: number;
	readonly kind: "confirm" | "modal";
	readonly title: string;
	readonly text: string;
	/** Present for a `confirm`; resolved with the user's answer. */
	readonly deferred?: Deferred.Deferred<boolean>;
}

/** What the overlay region renders, and the whole of its state. */
export interface OverlayState {
	readonly toasts: readonly Toast[];
	readonly modals: readonly ModalRequest[];
}

const emptyOverlay: OverlayState = { toasts: [], modals: [] };

/**
 * The Effect-facing source of truth. Created at module load with a synchronous
 * run: `SubscriptionRef.make` is a pure `Ref` allocation with no services, so
 * this is not the promise-backed `ManagedRuntime.runSync` boot trap (which
 * would require the version read from the shell).
 */
const overlayRef = Effect.runSync(SubscriptionRef.make(emptyOverlay));

/** The React-facing projection; only {@link commit} writes it. */
let snapshot: OverlayState = emptyOverlay;

const listeners = new Set<() => void>();

/** The current overlay state. Referentially stable between mutations. */
export const getOverlaySnapshot = (): OverlayState => snapshot;

/** Subscribe to overlay changes, in the `useSyncExternalStore` shape. */
export const subscribeOverlay = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** The overlay state as a stream, for an Effect consumer (spec §3). */
export const overlayChanges: Stream.Stream<OverlayState> =
	SubscriptionRef.changes(overlayRef);

/**
 * The one write path: the ref and the React projection are set in the same
 * synchronous step and the listeners woken once, so no consumer can observe a
 * state the other does not have.
 */
const commit = (next: OverlayState): void => {
	Effect.runSync(SubscriptionRef.set(overlayRef, next));
	snapshot = next;
	for (const listener of listeners) listener();
};

/** Monotonic ids: a removal targets one entry even if its text repeats. */
let nextId = 0;

const allocateId = (): number => {
	nextId += 1;
	return nextId;
};

const addToast = (entry: Toast): void => {
	commit({ ...snapshot, toasts: [...snapshot.toasts, entry] });
};

const removeToast = (id: number): void => {
	commit({
		...snapshot,
		toasts: snapshot.toasts.filter((entry) => entry.id !== id),
	});
};

const addModal = (request: ModalRequest): void => {
	commit({ ...snapshot, modals: [...snapshot.modals, request] });
};

const removeModal = (id: number): void => {
	commit({
		...snapshot,
		modals: snapshot.modals.filter((entry) => entry.id !== id),
	});
};

/** Drop one toast (the dismiss control). */
export const dismissToast = (id: number): void => {
	removeToast(id);
};

/**
 * Resolve the request called `id` — `true` from a confirm's affirmative, `false`
 * from a cancel, a backdrop or a close. The entry leaves the queue first (so the
 * next request becomes the head) and its `Deferred`, when it has one, is
 * completed with the answer.
 */
export const resolveModal = (id: number, value: boolean): void => {
	const request = snapshot.modals.find((entry) => entry.id === id);
	if (request === undefined) return;
	removeModal(id);
	if (request.deferred !== undefined) {
		Deferred.doneUnsafe(request.deferred, Effect.succeed(value));
	}
};

/** Drop every toast and modal. The host's reset, and each test's isolation. */
export const clearOverlay = (): void => {
	for (const modalRequest of snapshot.modals) {
		if (modalRequest.deferred !== undefined) {
			Deferred.doneUnsafe(modalRequest.deferred, Effect.succeed(false));
		}
	}
	commit(emptyOverlay);
};

/** A refused request is a logged `PluginFault`, never a throw (spec §9). */
const refuse = (detail: string): Effect.Effect<void> =>
	Effect.logWarning(new PluginFault({ detail }));

/** Put one toast on the stack, and hand its lifetime to the pushing scope. */
const presentNotice = (
	label: string,
	options: ToastOptions,
	sticky: boolean,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const parsed = toastSchema.safeParse(options);
		if (!parsed.success) {
			yield* refuse(`${label}: ${parsed.error.message}`);
			return;
		}
		const id = allocateId();
		addToast({
			id,
			text: parsed.data.text,
			tone: parsed.data.tone,
			sticky,
		});

		const scope = yield* Effect.serviceOption(Scope.Scope);
		if (Option.isSome(scope)) {
			yield* Scope.addFinalizer(
				scope.value,
				Effect.sync(() => removeToast(id)),
			);
		}
		if (sticky) return;

		const expire = Effect.sleep(
			Duration.millis(parsed.data.ttl ?? DEFAULT_TOAST_TTL),
		).pipe(Effect.andThen(Effect.sync(() => removeToast(id))));
		// With a scope, the expiry fibre dies with the pushing plugin; without
		// one (a host caller outside a plugin), it is detached so the `ttl`
		// still fires rather than hanging on the caller's own lifetime.
		yield* Option.isSome(scope)
			? Effect.forkIn(expire, scope.value)
			: Effect.forkDetach(expire);
	});

/** Show a toast (spec §5); it expires after `ttl` unless dismissed first. */
export const toast = (options: ToastOptions): Effect.Effect<void> =>
	presentNotice("notify.toast", options, false);

/** Show a sticky notice; it stays until dismissed or its plugin unloads. */
export const banner = (options: BannerOptions): Effect.Effect<void> =>
	presentNotice("notify.banner", options, true);

/**
 * Ask the user a yes/no question (spec §5) and resolve with the answer. A
 * second call while one is open queues behind it (the modal queue renders one
 * head at a time) and each waits on its own `Deferred`.
 */
export const confirm = (options: ConfirmOptions): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const parsed = confirmSchema.safeParse(options);
		if (!parsed.success) {
			yield* refuse(`notify.confirm: ${parsed.error.message}`);
			return false;
		}
		const deferred = yield* Deferred.make<boolean>();
		const id = allocateId();
		addModal({
			id,
			kind: "confirm",
			title: parsed.data.title ?? "Confirm",
			text: parsed.data.text,
			deferred,
		});
		// `ensuring` runs on every exit — the answer, a cancellation or an
		// unload. It removes a request the user never answered, so a cancelled
		// requestor cannot leave the queue (and the UI) waiting on a Deferred
		// nothing will complete.
		return yield* Deferred.await(deferred).pipe(
			Effect.ensuring(Effect.sync(() => resolveModal(id, false))),
		);
	});

/** Show a modal that displays a title and a body until it is dismissed. */
export const modal = (options: ModalOptions): Effect.Effect<void> =>
	Effect.gen(function* () {
		const parsed = modalSchema.safeParse(options);
		if (!parsed.success) {
			yield* refuse(`notify.modal: ${parsed.error.message}`);
			return;
		}
		const id = allocateId();
		addModal({
			id,
			kind: "modal",
			title: parsed.data.title,
			text: parsed.data.content,
		});
		const scope = yield* Effect.serviceOption(Scope.Scope);
		if (Option.isSome(scope)) {
			yield* Scope.addFinalizer(
				scope.value,
				Effect.sync(() => removeModal(id)),
			);
		}
	});

/** The notification surface as a plugin's `setup` receives it (spec §2). */
export interface NotifyService {
	toast(options: ToastOptions): void;
	banner(options: BannerOptions): void;
	modal(options: ModalOptions): void;
	confirm(options: ConfirmOptions): Effect.Effect<boolean>;
}

/**
 * Build the notification calls bound to one plugin's `Scope`, the shape
 * `host.notify` takes (spec §2). `toast`/`banner`/`modal` are synchronous
 * because a plugin's `setup` is synchronous; each runs its primitive on the
 * subsystem's one runtime, so the scope it is given is the scope that owns the
 * presentation. `confirm` stays an `Effect` because it answers.
 */
export const makeNotifyService = (scope?: Scope.Scope): NotifyService => {
	const owned = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
		scope === undefined
			? effect
			: Effect.provideService(effect, Scope.Scope, scope);
	return {
		toast: (options) => {
			runtime.runFork(owned(toast(options)));
		},
		banner: (options) => {
			runtime.runFork(owned(banner(options)));
		},
		modal: (options) => {
			runtime.runFork(owned(modal(options)));
		},
		confirm: (options) => owned(confirm(options)),
	};
};

/** The overlay state, re-rendering on every change (the toast/modal region). */
export const useOverlay = (): OverlayState =>
	useSyncExternalStore(subscribeOverlay, getOverlaySnapshot);
