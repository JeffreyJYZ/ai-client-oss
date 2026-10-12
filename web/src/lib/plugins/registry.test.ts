import { describe, expect, test } from "bun:test";
import type { RegistryEntry } from "@lib/plugins/registry";
import { makeRegistry } from "@lib/plugins/registry";
import {
	type Cause,
	Effect,
	Exit,
	Fiber,
	Logger,
	Queue,
	Scope,
	Stream,
} from "effect";

type BasicEntry = { id: string; owner: string };

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

const idsOf = (list: readonly RegistryEntry[]) => list.map((entry) => entry.id);

const isFault = (
	m: unknown,
): m is { readonly _tag: "PluginFault"; readonly detail: string } =>
	typeof m === "object" &&
	m !== null &&
	(m as { _tag?: unknown })._tag === "PluginFault";

describe("registry", () => {
	test("sorts by order, then priority, then registration order", async () => {
		const r = await run(
			makeRegistry<{
				id: string;
				owner: string;
				order?: number;
				priority?: number;
			}>("t"),
		);
		await run(r.add({ id: "b", owner: "p1", order: 2 }));
		await run(r.add({ id: "a", owner: "p1", order: 1 }));
		await run(r.add({ id: "c", owner: "p1" }));
		expect(idsOf(await run(r.entries()))).toEqual(["a", "b", "c"]);

		// Equal explicit order resolves by priority (higher first), then by
		// registration order.
		await run(r.add({ id: "d", owner: "p1", order: 3, priority: 1 }));
		await run(r.add({ id: "e", owner: "p1", order: 3, priority: 5 }));
		await run(r.add({ id: "f", owner: "p1", order: 3 }));
		expect(idsOf(await run(r.entries()))).toEqual([
			"a",
			"b",
			"e",
			"d",
			"f",
			"c",
		]);
	});

	test("a duplicate id replaces in place and logs a PluginFault, never duplicates", async () => {
		const r = await run(makeRegistry<BasicEntry>("t"));
		const stale = await run(r.add({ id: "a", owner: "p1" }));
		await run(r.add({ id: "z", owner: "p1" }));

		const logged: Array<unknown> = [];
		const logger = Logger.make<unknown, void>((options) => {
			if (Array.isArray(options.message)) logged.push(...options.message);
		});
		await run(
			Effect.provide(r.add({ id: "a", owner: "p2" }), Logger.layer([logger])),
		);

		const entries = await run(r.entries());
		expect(entries.length).toBe(2);
		expect(idsOf(entries)).toEqual(["a", "z"]);
		// Replaced in place: it keeps its position, the later value wins.
		expect(entries[0]?.owner).toBe("p2");
		expect(entries[1]?.owner).toBe("p1");

		const faults = logged.filter(isFault);
		expect(faults.length).toBe(1);
		expect(faults[0]?.detail).toContain("a");

		// A stale handle for the replaced entry must not remove its successor.
		stale.dispose();
		expect(idsOf(await run(r.entries()))).toEqual(["a", "z"]);
	});

	test("dispose removes only that entry", async () => {
		const r = await run(makeRegistry<BasicEntry>("t"));
		const first = await run(r.add({ id: "a", owner: "p1" }));
		await run(r.add({ id: "b", owner: "p1" }));

		first.dispose();
		expect(idsOf(await run(r.entries()))).toEqual(["b"]);

		// Disposing twice is a no-op, never a second removal.
		first.dispose();
		expect(idsOf(await run(r.entries()))).toEqual(["b"]);
	});

	test("a plugin scope closes every registration it made", async () => {
		const r = await run(makeRegistry<BasicEntry>("t"));
		// Registered with no ambient scope, so no scope owns it.
		await run(r.add({ id: "outside", owner: "p2" }));

		const scope = await run(Scope.make());
		await run(
			Effect.provideService(
				Effect.gen(function* () {
					yield* r.add({ id: "x", owner: "p1" });
					yield* r.add({ id: "y", owner: "p1" });
				}),
				Scope.Scope,
				scope,
			),
		);
		await run(Scope.close(scope, Exit.void));

		expect(await run(r.ownedBy("p1"))).toEqual([]);
		// The close removed exactly what that scope registered, nothing else.
		expect(idsOf(await run(r.ownedBy("p2")))).toEqual(["outside"]);
	});

	test("changes emits on add and on dispose", async () => {
		// One effect, because a `forkChild` fiber lives only as long as the run
		// that started it.
		const snapshots = await run(
			Effect.gen(function* () {
				const r = yield* makeRegistry<BasicEntry>("t");
				const queue = yield* Queue.unbounded<
					readonly BasicEntry[],
					Cause.Done
				>();
				const fiber = yield* Stream.runIntoQueue(r.changes, queue).pipe(
					Effect.forkChild,
				);

				const seen: Array<readonly string[]> = [];
				// The replay buffer hands the current snapshot to the subscriber,
				// so this take also proves the subscription is live before the add.
				seen.push(idsOf(yield* Queue.take(queue)));

				const entry = yield* r.add({ id: "a", owner: "p1" });
				seen.push(idsOf(yield* Queue.take(queue)));

				entry.dispose();
				seen.push(idsOf(yield* Queue.take(queue)));

				yield* Fiber.interrupt(fiber);
				return seen;
			}),
		);

		expect(snapshots).toEqual([[], ["a"], []]);
	});
});
