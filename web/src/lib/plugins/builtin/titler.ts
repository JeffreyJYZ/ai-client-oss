import type { Conversation } from "@lib/db/types";
import { isDesktop } from "@lib/platform";
import type { Host } from "@lib/plugins/host";
import {
	type ProviderEntry,
	resolveProviderSync,
} from "@lib/plugins/providers";
import { resolveTitlerModel, titleFor } from "@lib/titler";
import { recordTitlerOutcome, type TitlerOutcome } from "@lib/titlerStatus";
import { Cause, Effect, Option } from "effect";
import {
	getChat,
	subscribeUserMessage,
	titleIfDerived,
	type UserMessageSignal,
} from "@/state/chat";
import { getSettings } from "@/state/settings";
import { TitlerSection } from "@/ui/titler/TitlerSection";

/**
 * The `app.titler` area (P3): one model-written title per new conversation,
 * once, without ever replacing a title the user chose and without ever blocking
 * a turn.
 *
 * **The trigger is two halves, and both are required** (the spec's "The
 * trigger"). `messages.length === 1` says *this send was the conversation's
 * first* — the signal fires after the user's row is stored, so one message
 * means there were none before it — and `titleSource` not `"model"`/`"user"`
 * says the title is still the titler's to write. Either half alone is wrong:
 * the source half alone re-fires on every later send after a first attempt that
 * failed, and it would also title a hydrated conversation the user never asked
 * to name.
 *
 * **The run mechanism has no room for invention** (spec's "How it runs"): the
 * provider is resolved **synchronously** (`resolveProviderSync`, which bridges
 * to the runtime and supplies the context) and its **value** is passed into
 * `titleFor`, whose effect requires nothing (`R = never`). That is the only
 * reading under which `host.run` can own it: `host.run`'s parameter is
 * `R = never` by type and it runs on the **empty-context runtime**, so it cannot
 * run anything that needs `HostServices`; `runtime.runFork` carries the context
 * but is not scope-owned and leaks past the area. Two scoped runs, not one: the
 * subscription below, and one run per title forked into **that same scope** from
 * inside the subscriber — so toggling the area off interrupts the subscription
 * *and* any title in flight.
 *
 * **The write goes through `titleIfDerived`** (T1b), never a raw
 * `updateConversation`: that function is what re-checks, in one synchronous
 * step, that the conversation still exists (a delete while a title was in
 * flight — the area's scope is not per conversation) and that the source is
 * still absent/`"derived"` (a rename landing mid-flight), and refuses
 * otherwise.
 *
 * The seams are injected for the same reason the memory area injects its
 * settings source: the tests must be able to hold a title open, land a rename
 * mid-flight and **count requests** (the "off means zero requests" invariant is
 * about the request, not about the title). {@link TitlerDeps} defaults to the
 * app's real collaborators.
 */

/** What one title request needs beyond the conversation and its first message. */
export interface TitlerTarget {
	/** The protocol value `resolveProviderSync` resolved. */
	readonly provider: ProviderEntry;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
}

/**
 * The trigger reads only these two fields off a conversation. `messages` is
 * `unknown[]` on purpose — the trigger counts it, nothing else — so a test can
 * state "this send was the first" without fabricating a whole `ChatMessage`.
 */
export interface TitlerConversation {
	readonly titleSource?: Conversation["titleSource"];
	readonly messages: readonly unknown[];
}

/**
 * Everything the area reaches outside itself. The four named in the plan —
 * `titleFor`, `readConversation`, `writeTitle`, `recordOutcome` — plus the
 * subscription and the target resolver, because a test cannot publish a user
 * message through the real store's private signal and cannot make the rule
 * resolve a model without the real settings store.
 */
export interface TitlerDeps {
	/** The store's first-message signal; returns the unsubscribe. */
	readonly subscribe: (
		handler: (signal: UserMessageSignal) => void,
	) => () => void;
	/** The conversation's trigger state, or `undefined` when it does not exist. */
	readonly readConversation: (id: string) => TitlerConversation | undefined;
	/** Resolve the provider, its credentials and the model, or `undefined`. */
	readonly resolveTarget: () => TitlerTarget | undefined;
	/** One title request (T3). */
	readonly titleFor: typeof titleFor;
	/** The `"model"` writer (T1b); `false` is a normal refusal. */
	readonly writeTitle: (id: string, title: string) => boolean;
	/** Record the last attempt for the settings hint. */
	readonly recordOutcome: (outcome: TitlerOutcome) => void;
}

/**
 * Resolve the provider **synchronously** and hand back everything the request
 * needs as values: the resolved `ProviderEntry`, the config's `baseUrl` and
 * `apiKey` (a `Provider` carries neither), and the model id.
 *
 * `resolveTitlerModel` has already decided, in the pure rule, whether a model
 * resolves at all — no model here means the honest no-op, so this returns
 * `undefined` and **no request is made**. A provider id the rule chose but the
 * registry does not know is the same no-op rather than a failed request.
 */
const resolveTarget = (): TitlerTarget | undefined => {
	const settings = getSettings();
	const resolved = resolveTitlerModel(settings, isDesktop);
	if (resolved === undefined) return undefined;
	const provider = resolveProviderSync(resolved.providerId);
	if (Option.isNone(provider)) return undefined;
	const config = settings.providers.find(
		(candidate) => candidate.id === resolved.providerId,
	);
	if (config === undefined) return undefined;
	return {
		provider: provider.value,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		model: resolved.model,
	};
};

/**
 * One line for the log and the status record: the typed failure's own message
 * when there is one — `Cause.pretty` renders a plain `Effect.fail("x")` as
 * `Error: x` — else the whole pretty cause, because a defect has no typed
 * message to prefer.
 */
const failureReason = (cause: Cause.Cause<string>): string =>
	Option.getOrElse(Cause.findErrorOption(cause), () => Cause.pretty(cause));

/** The app's real collaborators, one identity. */
const realDeps: TitlerDeps = {
	subscribe: subscribeUserMessage,
	readConversation: (id) =>
		getChat().conversations.find((conversation) => conversation.id === id),
	resolveTarget,
	titleFor,
	writeTitle: titleIfDerived,
	recordOutcome: recordTitlerOutcome,
};

/**
 * The `app.titler` area's registrar: the Titler settings section — the row that
 * says which model titles and what the last attempt did — and the first-message
 * subscription, owned by the area's scope.
 *
 * The subscription is installed inside the scoped run's acquire and removed by
 * its release, so closing the area (a reconcile, a toggle) stops it — and, from
 * inside the subscriber, each title is a second `host.run` forked into the same
 * scope, so closing the area interrupts a title in flight too.
 */
export const registerTitlerBuiltins = (
	host: Host,
	deps: TitlerDeps = realDeps,
): void => {
	// The settings row is the area's **own** registration: switching the area
	// off closes its scope and takes the row (and the model choice it explains)
	// with it. It is registered unconditionally while the area is on — the
	// picker is the only way to answer the rule's "no model" state — and it is
	// deliberately **not** in `builtin/settings.ts`: a section id registered
	// twice is refused first-wins, which would silently leave the row owned by
	// the wrong area and keep it rendered with this area off.
	host.ui.register({
		id: "settings.section.titler",
		slot: "settings.sections",
		component: TitlerSection,
		order: 75,
	});

	/**
	 * Guarded so one tab fires once per conversation. **This set is per page:**
	 * two tabs can title the same new conversation at the same time, and that is
	 * harmless — the last write wins on a non-`user` title — but it is not
	 * "once", and this set is not a lock. It only keeps a single page from firing
	 * twice for the same conversation (a signal arriving again while the first
	 * title is still in flight).
	 */
	const inFlight = new Set<string>();

	/** One title request, forked into the area's scope by the caller. */
	const title = (signal: UserMessageSignal): Effect.Effect<void, string> =>
		Effect.suspend(() => {
			const target = deps.resolveTarget();
			if (target === undefined) return Effect.void;
			const model = target.model;
			// The call sits in its own `suspend` so a **synchronous throw** out
			// of `send` becomes a defect of this effect and reaches the
			// `matchCause` below; a throw evaluated by the outer thunk would
			// escape it and land on `host.run`'s logger instead, recorded
			// nowhere.
			return Effect.suspend(() =>
				deps.titleFor({
					provider: target.provider,
					baseUrl: target.baseUrl,
					apiKey: target.apiKey,
					model,
					conversationId: signal.conversationId,
					firstMessage: signal.text,
				}),
			).pipe(
				// The success half does the work and discards the title, so the
				// effect's value is `void` and only a **failure** reaches the
				// `catchCause` below — there is no sentinel to confuse with the
				// legitimate "the model returned nothing" answer.
				Effect.flatMap((title) =>
					Effect.sync(() => {
						if (title === undefined) {
							deps.recordOutcome({
								model,
								ok: false,
								reason: "the model returned no usable title",
							});
							return;
						}
						const wrote = deps.writeTitle(signal.conversationId, title);
						deps.recordOutcome({
							model,
							ok: true,
							reason: wrote
								? "titled"
								: "the conversation was renamed or deleted first",
						});
					}),
				),
				// `catchCause`, not the typed-error form, and not `matchEffect`
				// (which re-raises a defect): a protocol whose `send` throws
				// synchronously **defects** `titleFor` — the chat path isolates
				// that in `sendThrough`, `titleFor` does not — and a defect must
				// still be logged and recorded, or a faulting provider looks like a
				// titler that never ran. An interruption is re-raised: a teardown
				// is not a fault.
				Effect.catchCause((cause) => {
					if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
					const reason = failureReason(cause);
					return Effect.andThen(
						Effect.sync(() => {
							deps.recordOutcome({ model, ok: false, reason });
						}),
						Effect.logWarning(
							`the titler could not title conversation ${signal.conversationId}: ${reason}`,
						),
					);
				}),
				// Always, including on a defect or an interruption: a conversation
				// left in the set would never be retried by this page.
				Effect.ensuring(
					Effect.sync(() => {
						inFlight.delete(signal.conversationId);
					}),
				),
			);
		});

	/** The signal handler: decide synchronously, then fork the request. */
	const onSignal = (signal: UserMessageSignal): void => {
		// A message with no text (attachments only) is not a title source.
		if (signal.text.trim() === "") return;
		const conversation = deps.readConversation(signal.conversationId);
		if (conversation === undefined) return;
		// The first half: one message after this send's append means there were
		// none before it.
		if (conversation.messages.length !== 1) return;
		// The second half; `writeTitle` re-checks it at write time.
		if (
			conversation.titleSource === "model" ||
			conversation.titleSource === "user"
		)
			return;
		if (inFlight.has(signal.conversationId)) return;
		inFlight.add(signal.conversationId);
		host.run(title(signal));
	};

	host.run(
		Effect.scoped(
			Effect.acquireRelease(
				Effect.sync(() => deps.subscribe(onSignal)),
				(stop) => Effect.sync(() => stop()),
			).pipe(Effect.andThen(Effect.never)),
		),
	);
};
