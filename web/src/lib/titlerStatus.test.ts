import { describe, expect, test } from "bun:test";
import {
	getTitlerOutcome,
	recordTitlerOutcome,
	subscribeTitlerOutcome,
} from "@lib/titlerStatus";

/**
 * The last-attempt record: it exists so the settings hint can say *which* no-op
 * this is. The two things worth pinning are that the record is the **last**
 * attempt (not a history) and that a record wakes a subscriber.
 */

describe("titlerStatus", () => {
	test("records the last attempt, replacing the previous one", () => {
		recordTitlerOutcome({ model: "free-a", ok: false, reason: "boom" });
		expect(getTitlerOutcome()).toEqual({
			model: "free-a",
			ok: false,
			reason: "boom",
		});

		// The last attempt wins: no per-conversation history accumulates.
		recordTitlerOutcome({ model: "free-b", ok: true, reason: "titled" });
		expect(getTitlerOutcome()).toEqual({
			model: "free-b",
			ok: true,
			reason: "titled",
		});
	});

	test("a record wakes subscribers, and the unsubscribe stops them", () => {
		let calls = 0;
		const stop = subscribeTitlerOutcome(() => {
			calls += 1;
		});

		recordTitlerOutcome({ model: "free", ok: true, reason: "titled" });
		expect(calls).toBe(1);

		stop();
		recordTitlerOutcome({ model: "free", ok: true, reason: "titled" });
		expect(calls).toBe(1);
	});
});
