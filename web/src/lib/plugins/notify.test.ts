import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearOverlay,
	confirm,
	dismissToast,
	getOverlaySnapshot,
	modal,
	resolveModal,
	subscribeOverlay,
	toast,
} from "@lib/plugins/notify";
import { Duration, Effect, Exit, Fiber, Logger, Scope } from "effect";

/**
 * The notification surface's rules (spec §5), driven through the real Effect
 * primitives — no fake registry and no `mock.module` of a project module (R13).
 * bun's runner has no DOM, so what is asserted here is the *state* the overlay
 * components render: what is in the toast stack and the modal queue, and when it
 * leaves. The rendered DOM is Task 15's browser proof.
 *
 * The three load-bearing behaviours the brief names:
 * - a toast expires on its `ttl` and wakes the store's listeners;
 * - a second `confirm` queues behind the open one rather than replacing it;
 * - the pushing plugin's `Scope` owns a queued toast, so closing the scope
 *   (unload) drops it before its `ttl` ever fires.
 */

/** A logger that swallows output, so an expected refusal warning stays out of the run. */
const silent = Logger.layer([Logger.make(() => {})]);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect);

/** The toast texts currently queued, in order. */
const toastTexts = (): readonly string[] =>
	getOverlaySnapshot().toasts.map((entry) => entry.text);

/** The modal titles currently queued, in order (only the head is rendered). */
const modalTitles = (): readonly string[] =>
	getOverlaySnapshot().modals.map((entry) => entry.title);

const makeScope = (): Scope.Closeable => Effect.runSync(Scope.make());

beforeEach(() => {
	clearOverlay();
});

describe("toasts", () => {
	test("a toast pushes, expires after its ttl and wakes its listeners", async () => {
		let notifications = 0;
		const unsubscribe = subscribeOverlay(() => {
			notifications += 1;
		});
		const scope = makeScope();

		await run(
			Effect.gen(function* () {
				yield* Effect.provideService(
					toast({ text: "hello", ttl: 10 }),
					Scope.Scope,
					scope,
				);
				expect(toastTexts()).toEqual(["hello"]);
				const afterPush = notifications;
				expect(afterPush).toBeGreaterThan(0);

				yield* Effect.sleep(Duration.millis(40));

				expect(toastTexts()).toEqual([]);
				// The listeners fired again on the expiry, not only on the push.
				expect(notifications).toBeGreaterThan(afterPush);
				yield* Scope.close(scope, Exit.void);
			}),
		);

		unsubscribe();
	});

	test("closing the pushing scope (unload) drops a queued toast", async () => {
		const scope = makeScope();

		await run(
			Effect.gen(function* () {
				// A ttl far beyond the test, so only the unload can remove it.
				yield* Effect.provideService(
					toast({ text: "doomed", ttl: 60_000 }),
					Scope.Scope,
					scope,
				);
				expect(toastTexts()).toEqual(["doomed"]);

				yield* Scope.close(scope, Exit.void);

				expect(toastTexts()).toEqual([]);
			}),
		);
	});

	test("a toast is dismissible by id before its ttl fires", async () => {
		const scope = makeScope();
		await run(
			Effect.gen(function* () {
				yield* Effect.provideService(
					toast({ text: "dismiss me", ttl: 60_000 }),
					Scope.Scope,
					scope,
				);
				const [entry] = getOverlaySnapshot().toasts;
				if (entry !== undefined) dismissToast(entry.id);
				expect(toastTexts()).toEqual([]);
				yield* Scope.close(scope, Exit.void);
			}),
		);
	});

	test("a malformed toast is refused, not rendered", async () => {
		await run(
			Effect.provide(
				toast({ text: 42 } as unknown as { readonly text: string }),
				silent,
			),
		);
		expect(toastTexts()).toEqual([]);
	});
});

describe("confirm", () => {
	test("a second confirm queues behind the open one instead of replacing it", async () => {
		await run(
			Effect.gen(function* () {
				const first = yield* Effect.forkChild(confirm({ text: "first" }));
				yield* Effect.yieldNow;
				const second = yield* Effect.forkChild(confirm({ text: "second" }));
				yield* Effect.yieldNow;

				// Both are queued — the second did not replace the first.
				expect(modalTitles()).toEqual(["Confirm", "Confirm"]);
				expect(getOverlaySnapshot().modals.map((m) => m.text)).toEqual([
					"first",
					"second",
				]);

				// The UI resolves the head; the first requestor gets its answer.
				const [head] = getOverlaySnapshot().modals;
				if (head !== undefined) resolveModal(head.id, true);
				expect(yield* Fiber.join(first)).toBe(true);
				expect(getOverlaySnapshot().modals.map((m) => m.text)).toEqual([
					"second",
				]);

				const [next] = getOverlaySnapshot().modals;
				if (next !== undefined) resolveModal(next.id, false);
				expect(yield* Fiber.join(second)).toBe(false);
				expect(modalTitles()).toEqual([]);
			}),
		);
	});

	test("cancelling a queued confirm leaves nothing behind", async () => {
		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(confirm({ text: "cancel me" }));
				yield* Effect.yieldNow;
				expect(modalTitles()).toEqual(["Confirm"]);

				yield* Fiber.interrupt(fiber);

				// A cancelled requestor cannot leave a modal the UI waits on.
				expect(modalTitles()).toEqual([]);
			}),
		);
	});
});

describe("modal", () => {
	test("at most one modal is queued at a time and closing it pops the next", async () => {
		const scope = makeScope();
		await run(
			Effect.gen(function* () {
				yield* Effect.provideService(
					modal({ title: "One", content: "first" }),
					Scope.Scope,
					scope,
				);
				yield* Effect.provideService(
					modal({ title: "Two", content: "second" }),
					Scope.Scope,
					scope,
				);
				expect(modalTitles()).toEqual(["One", "Two"]);

				const [head] = getOverlaySnapshot().modals;
				if (head !== undefined) resolveModal(head.id, false);
				expect(modalTitles()).toEqual(["Two"]);

				// Unloading the plugin's scope removes its still-open modal too.
				yield* Scope.close(scope, Exit.void);
				expect(modalTitles()).toEqual([]);
			}),
		);
	});
});
