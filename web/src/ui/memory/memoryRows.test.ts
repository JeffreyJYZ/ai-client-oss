import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryEntry } from "@lib/memoryNotes";
import * as memoryNotes from "@lib/memoryNotes";
import { registerMemoryBuiltins } from "@lib/plugins/builtin/memory";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { Effect, Scope } from "effect";
import { setSettings } from "@/state/settings";
import {
	changedLabel,
	memoryRows,
	NO_REVERT_REASON,
} from "@/ui/memory/memoryRows";

/**
 * The Memory section's pure half, and the safety asymmetry the UI exists to
 * keep.
 *
 * The component is proven in a browser (the plan's production-bundle run); what
 * lives here are the two things a browser cannot pin: the view-model's values,
 * and the claim that **no tool can purge** — a property of module exports and
 * the tool registry, not of any rendered pixel.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = 1_700_000_000_000;

const note = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
	id: "editor-theme",
	content: "The user prefers a dark editor.",
	updatedAt: NOW,
	history: [],
	...overrides,
});

describe("memoryRows", () => {
	test("a live row carries the note's id, its content and its last-changed time", () => {
		const rows = memoryRows([note()], NOW);

		expect(rows.live).toHaveLength(1);
		expect(rows.deleted).toHaveLength(0);
		const row = rows.live[0];
		expect(row?.id).toBe("editor-theme");
		expect(row?.content).toBe("The user prefers a dark editor.");
		// Last changed is the entry's own timestamp, copied — not `now`.
		expect(row?.updatedAt).toBe(NOW);
		expect(row?.changed).toBe(changedLabel(NOW, NOW));
	});

	test("a soft-deleted note is in the deleted list and not the live one", () => {
		const live = note({ id: "live-note" });
		const removed = note({ id: "gone-note", deletedAt: NOW - HOUR });
		const rows = memoryRows([live, removed], NOW);

		expect(rows.live.map((row) => row.id)).toEqual(["live-note"]);
		expect(rows.deleted.map((row) => row.id)).toEqual(["gone-note"]);
	});

	test("canRevert is false with a visible reason when there is no history", () => {
		const rows = memoryRows([note({ history: [] })], NOW);

		const row = rows.live[0];
		expect(row?.canRevert).toBe(false);
		expect(row?.revertReason).toBe(NO_REVERT_REASON);
		expect((row?.revertReason ?? "").length).toBeGreaterThan(0);
	});

	test("canRevert is true, and carries no reason, once history exists", () => {
		const rows = memoryRows(
			[note({ history: [{ content: "older", at: NOW - HOUR }] })],
			NOW,
		);

		const row = rows.live[0];
		expect(row?.canRevert).toBe(true);
		expect(row?.revertReason).toBeUndefined();
	});

	test("a deleted note with history is restorable; one without is disabled with a reason", () => {
		const rows = memoryRows(
			[
				note({
					id: "restorable",
					deletedAt: NOW - HOUR,
					history: [{ content: "before removal", at: NOW - 2 * HOUR }],
				}),
				note({ id: "nothing-to-undo", deletedAt: NOW - HOUR, history: [] }),
			],
			NOW,
		);

		const byId = new Map(rows.deleted.map((row) => [row.id, row]));
		expect(byId.get("restorable")?.canRevert).toBe(true);
		expect(byId.get("restorable")?.revertReason).toBeUndefined();
		expect(byId.get("nothing-to-undo")?.canRevert).toBe(false);
		expect(byId.get("nothing-to-undo")?.revertReason).toBe(NO_REVERT_REASON);
	});

	test("the last-changed label is a function of updatedAt, not of the render's now", () => {
		const rows = memoryRows(
			[
				note({ id: "just-now", updatedAt: NOW }),
				note({ id: "minutes", updatedAt: NOW - 5 * MINUTE }),
				note({ id: "hours", updatedAt: NOW - 3 * HOUR }),
			],
			NOW,
		);

		const changed = new Map(rows.live.map((row) => [row.id, row.changed]));
		expect(changed.get("just-now")).toBe("just now");
		expect(changed.get("minutes")).toBe("5m ago");
		expect(changed.get("hours")).toBe("3h ago");
	});

	test("newest change first, so the list reads newest at the top", () => {
		const rows = memoryRows(
			[
				note({ id: "older", updatedAt: NOW - HOUR }),
				note({ id: "newer", updatedAt: NOW }),
			],
			NOW,
		);

		expect(rows.live.map((row) => row.id)).toEqual(["newer", "older"]);
	});

	test("an older-than-a-day label leaves the relative forms", () => {
		const changed = changedLabel(NOW - 3 * DAY, NOW);

		expect(changed).not.toContain("ago");
		expect(changed.length).toBeGreaterThan(0);
	});
});

/* ---------------------------------------------------------------------------
 * The safety asymmetry, as a test.
 *
 * The spec's net: the agent may soft-delete forever and never purge, enforced
 * by the absence of a purge operation, not by prompt text. Two absences carry
 * it, and each can fail:
 *
 * - `lib/memoryNotes.ts` exports exactly the five operations; a `purgeMemory`
 *   (or any other exported function) breaks the exact-set check below.
 * - the `app.memory` area registers exactly the five named tools; a sixth
 *   registration — a `memory_purge` defined beside them — breaks the registry
 *   check.
 *
 * The name label is only a second, weaker check; the exact sets are the
 * assertion, so a store-wiping operation under any name still fails.
 * ------------------------------------------------------------------------- */

const PURGE_LIKE = /purge|destroy|wipe|erase|clear|reset|empty/i;

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const toolIds = (s: HostServicesShape): string[] =>
	Effect.runSync(s.tools.entries())
		.map((entry) => entry.id)
		.sort();

describe("the agent cannot purge", () => {
	test("the shared module exports exactly the five operations, none purge-like", () => {
		const exportedFunctions = Object.entries(memoryNotes)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();

		expect(exportedFunctions).toEqual([
			"addMemory",
			"listMemories",
			"removeMemory",
			"revertMemory",
			"updateMemory",
		]);
		expect(
			exportedFunctions.filter((name) => PURGE_LIKE.test(name)),
			"no exported operation may purge",
		).toEqual([]);
	});

	test("the app.memory area registers exactly the five tools, none purge-like", () => {
		const s = services();
		registerMemoryBuiltins(makeHost(s, "app.memory", scope()));

		expect(toolIds(s)).toEqual([
			"memory_add",
			"memory_list",
			"memory_remove",
			"memory_revert",
			"memory_update",
		]);
		expect(toolIds(s).filter((name) => PURGE_LIKE.test(name))).toEqual([]);
	});
});

// `app.memory`'s production registrar reads the shared settings store for the
// enablement flag; a direct call must see memory on. Set in both directions so
// this file can neither depend on nor leak the ambient value (the repo's
// order-dependent-leak class).
beforeEach(() => {
	setSettings({ memoriesEnabled: true });
});

afterEach(() => {
	setSettings({ memoriesEnabled: true });
});
