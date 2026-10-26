import { describe, expect, test } from "bun:test";
import {
	bootRegistryBridge,
	getRegistrySnapshot,
	installRegistryBridge,
	subscribeRegistry,
} from "@lib/plugins/bridge";
import { type Contribution, HostServices } from "@lib/plugins/host";
import { runtime } from "@lib/plugins/runtime";
import { Effect, Fiber, PubSub, Stream } from "effect";
import type { ComponentType } from "react";

/**
 * These tests drive the bridge against its own stream rather than the real
 * runtime's `ui` registry: the subject is the fold from emitted snapshots to
 * the module-level cache React reads, and a controlled `PubSub` makes each
 * mutation's effect exact instead of timing-dependent.
 *
 * The assertion that carries the task is referential stability —
 * `useSyncExternalStore` re-renders forever when `getSnapshot` returns a fresh
 * array on every call, so a stable identity between mutations is the property,
 * and `expect(getRegistrySnapshot()).toBe(previous)` is the discriminating
 * check (a fresh-array-per-call implementation fails it).
 */

const component = (): ComponentType<Record<string, unknown>> => () => null;

const entry = (id: string): Contribution => ({
	id,
	owner: "test-plugin",
	slot: "app.header.actions",
	component: component(),
});

const ids = (entries: readonly Contribution[]): string[] =>
	entries.map((item) => item.id);

/**
 * Yield to the scheduler until `done` holds (or give up after a generous
 * bound). The bridge's fold runs on its own fiber; a publish wakes it, and
 * `yieldNow` is what lets it run to completion before the next assertion.
 */
const settle = (done: () => boolean): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (let spins = 0; spins < 200 && !done(); spins++) {
			yield* Effect.yieldNow;
		}
	});

/**
 * Run `body` with the bridge installed on a stream seeded with `seed`, so the
 * replay buffer hands the seed to the bridge before the first mutation.
 */
const withBridge = (
	seed: readonly Contribution[],
	body: (
		publish: (entries: readonly Contribution[]) => Effect.Effect<void>,
	) => Effect.Effect<void>,
): Promise<void> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const pubsub = yield* PubSub.unbounded<readonly Contribution[]>({
				replay: 1,
			});
			yield* PubSub.publish(pubsub, seed);
			const fiber = yield* installRegistryBridge(
				Stream.fromPubSub(pubsub),
			).pipe(Effect.forkChild);
			yield* body((entries) => PubSub.publish(pubsub, entries));
			yield* Fiber.interrupt(fiber);
		}),
	);

describe("registry bridge", () => {
	test("the snapshot is referentially stable between mutations", async () => {
		let calls = 0;
		const unsubscribe = subscribeRegistry(() => {
			calls += 1;
		});

		await withBridge([entry("a")], (publish) =>
			Effect.gen(function* () {
				yield* settle(() => calls === 1);
				const first = getRegistrySnapshot();
				expect(ids(first)).toEqual(["a"]);
				// Two reads, no mutation between them: the SAME array. A fresh
				// array here is what re-renders React in an infinite loop.
				expect(getRegistrySnapshot()).toBe(first);
				expect(getRegistrySnapshot()).toBe(first);

				yield* publish([entry("a"), entry("b")]);
				yield* settle(() => calls === 2);
				const second = getRegistrySnapshot();
				expect(second).not.toBe(first);
				expect(ids(second)).toEqual(["a", "b"]);
				// Stable again once the mutation has been folded.
				expect(getRegistrySnapshot()).toBe(second);
			}),
		);

		unsubscribe();
	});

	test("a mutation produces exactly one new snapshot and one listener call", async () => {
		let calls = 0;
		const unsubscribe = subscribeRegistry(() => {
			calls += 1;
		});

		await withBridge([], (publish) =>
			Effect.gen(function* () {
				// The replayed seed is the first fold, not a mutation.
				yield* settle(() => calls === 1);
				const before = getRegistrySnapshot();
				expect(before).toEqual([]);
				expect(calls).toBe(1);

				yield* publish([entry("one")]);
				yield* settle(() => calls === 2);
				const after = getRegistrySnapshot();
				expect(ids(after)).toEqual(["one"]);
				expect(after).not.toBe(before);
				// Exactly one notify: no double notification, no missed one.
				expect(calls).toBe(2);

				// A second publish with an equal-but-distinct array is still
				// exactly one new snapshot and one call — the fold keys off the
				// emission, not a value comparison.
				yield* publish([entry("one")]);
				yield* settle(() => calls === 3);
				expect(calls).toBe(3);
				expect(getRegistrySnapshot()).not.toBe(after);
			}),
		);

		unsubscribe();
	});

	test("unsubscribing stops listener calls but the snapshot keeps updating", async () => {
		let calls = 0;
		const unsubscribe = subscribeRegistry(() => {
			calls += 1;
		});

		await withBridge([entry("a")], (publish) =>
			Effect.gen(function* () {
				yield* settle(() => calls === 1);
				expect(calls).toBe(1);

				unsubscribe();
				yield* publish([entry("a"), entry("b")]);
				yield* settle(() => ids(getRegistrySnapshot()).length === 2);

				// The cache still tracks the registry (React's own read is
				// correct); only the notification stopped.
				expect(ids(getRegistrySnapshot())).toEqual(["a", "b"]);
				expect(calls).toBe(1);

				// The returned unsubscribe is idempotent.
				unsubscribe();
				expect(calls).toBe(1);
			}),
		);
	});

	test("bootRegistryBridge folds the app's own ui registry into this snapshot", async () => {
		// The real wiring Task 6 calls from `main.tsx`: one runtime, one
		// stream. Nothing else in this file touches the runtime's registry, so
		// an entry registered here must show up in the module snapshot.
		bootRegistryBridge();

		await runtime.runPromise(
			Effect.gen(function* () {
				const services = yield* HostServices;
				yield* services.ui.add({
					id: "test.boot",
					owner: "test-plugin",
					slot: "app.header.actions",
					component: component(),
				});
				yield* settle(() => ids(getRegistrySnapshot()).includes("test.boot"));
			}),
		);

		expect(ids(getRegistrySnapshot())).toContain("test.boot");
	});
});
