import { Cause, Effect } from "effect";

/**
 * The **last** title attempt's outcome — one small module-level record, so the
 * settings row can tell "no model resolved" (nothing ran at all) apart from
 * "resolved and then failed" (a dead id, a refused preflight, a 401), which are
 * indistinguishable from the title alone.
 *
 * Deliberately a single slot, never a per-conversation history: the record
 * exists to explain the hint, and an unbounded map keyed by conversation would
 * grow with every conversation the user ever opens. The last attempt wins.
 */

export interface TitlerOutcome {
	/** The model id the attempt used. */
	readonly model: string;
	readonly ok: boolean;
	/** One line the settings hint can show: why it failed, or that it landed. */
	readonly reason: string;
}

let last: TitlerOutcome | undefined;
const listeners = new Set<() => void>();

/** The outcome of the most recent attempt, or `undefined` if none has run. */
export const getTitlerOutcome = (): TitlerOutcome | undefined => last;

/**
 * Record one attempt's outcome and wake the settings hint.
 *
 * Each listener runs in its own isolated step, exactly as `publishUserMessage`
 * does (`state/chat.ts`): a subscriber is another module's code, and
 * `recordTitlerOutcome` is called **from inside the titler's own effect** — so a
 * listener that throws would otherwise defect that effect and, via the titler's
 * `catchCause`, replace the real outcome with a bogus failure (and skip every
 * listener after it). The record itself is set before anyone is told.
 */
export const recordTitlerOutcome = (outcome: TitlerOutcome): void => {
	last = outcome;
	for (const listener of [...listeners]) {
		Effect.runSync(
			Effect.sync(() => listener()).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						`a titler-status subscriber faulted and was skipped: ${Cause.pretty(cause)}`,
					),
				),
			),
		);
	}
};

/** Notify on every record; returns the unsubscribe. */
export const subscribeTitlerOutcome = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
