import { describe, expect, spyOn, test } from "bun:test";
import { addMemory, type MemoryEntry } from "@lib/memoryNotes";
import { BUILTIN_AREAS, BUILTIN_IDENTITIES } from "@lib/plugins/areas";
import { makeBuiltinsReconciler } from "@lib/plugins/builtin";
import {
	appMemorySettings,
	MEMORY_TOOL_NAMES,
	type MemorySettingsSource,
	makeMemoryToolRegistration,
	registerMemoryBuiltins,
} from "@lib/plugins/builtin/memory";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import {
	executeTool,
	registerTool,
	type Tool,
	type ToolEntry,
} from "@lib/plugins/tools";
import type { ToolCallData } from "@lib/providers/types";
import { Effect, Scope } from "effect";

/**
 * The five memory tools, and the registration gate that keeps them off the wire
 * when memory is off.
 *
 * The gate is the half that matters: a registered tool is what the outgoing
 * body announces, so "off" has to mean **absent from the registry**, never a
 * refusal inside `execute`. That is why the enablement half is driven through
 * the injected {@link MemorySettingsSource} seam rather than the app's own
 * settings store: a test that toggled the real store would leak an off state
 * into every later suite in the same bun process (one module registry, order
 * dependent), which is exactly the "passing for the wrong reason" failure the
 * brief names.
 *
 * The declarations are asserted as literals, not against `MEMORY_TOOL_NAMES`,
 * so a renamed tool fails here instead of renaming both sides of the check.
 */

/** A settings source a test drives directly: value in, notification out. */
const makeSource = (initial: readonly MemoryEntry[] = [], enabled = true) => {
	let notes = [...initial];
	let on = enabled;
	const listeners = new Set<() => void>();
	const source: MemorySettingsSource = {
		enabled: () => on,
		notes: () => notes,
		saveNotes: (next) => {
			notes = [...next];
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		source,
		getNotes: (): readonly MemoryEntry[] => notes,
		setEnabled: (value: boolean): void => {
			on = value;
		},
		emit: (): void => {
			for (const listener of listeners) listener();
		},
	};
};

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const toolIds = (s: HostServicesShape): string[] =>
	Effect.runSync(s.tools.entries())
		.map((entry) => entry.id)
		.sort();

const call = (name: string, args: string): ToolCallData => ({
	id: "call-1",
	key: "0",
	name,
	args,
});

const runWith = <A, E>(
	effect: Effect.Effect<A, E, HostServices>,
	s: HostServicesShape,
): Promise<A> =>
	Effect.runPromise(Effect.provideService(effect, HostServices, s));

const callTool = (
	s: HostServicesShape,
	name: string,
	args: Record<string, unknown>,
) => runWith(executeTool(name, call(name, JSON.stringify(args))), s);

describe("the five memory tools", () => {
	test("all five register, with the declarations the spec names", () => {
		const s = services();
		const { source } = makeSource();
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			source,
		).apply();

		// The wire names are the literals the spec and T6 name.
		expect(toolIds(s)).toEqual([
			"memory_add",
			"memory_list",
			"memory_remove",
			"memory_revert",
			"memory_update",
		]);
		expect([...MEMORY_TOOL_NAMES].sort()).toEqual(toolIds(s));

		// Only `addTool` writes tools, so reading them back as `ToolEntry` is the
		// same narrowing `state/chat.ts` makes.
		for (const entry of Effect.runSync(
			s.tools.entries(),
		) as readonly ToolEntry[]) {
			expect(entry.declaration.name).toBe(entry.id);
			expect(entry.declaration.description.trim().length).toBeGreaterThan(0);
			expect(entry.declaration.parameters.type).toBe("object");
		}
	});

	test("every tool reaches the store through T1, and each does one step", async () => {
		const s = services();
		const store = makeSource();
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			store.source,
		).apply();

		const added = await callTool(s, "memory_add", {
			id: "editor-theme",
			content: "The user prefers a dark editor.",
		});
		expect(added.failed).toBe(false);
		expect(store.getNotes().map((note) => note.id)).toEqual(["editor-theme"]);

		const listed = await callTool(s, "memory_list", {});
		expect(listed.failed).toBe(false);
		expect(listed.result).toContain("editor-theme");
		expect(listed.result).toContain("The user prefers a dark editor.");

		const updated = await callTool(s, "memory_update", {
			id: "editor-theme",
			content: "The user prefers a light editor.",
		});
		expect(updated.failed).toBe(false);
		expect(store.getNotes()[0]?.content).toBe(
			"The user prefers a light editor.",
		);
		expect(store.getNotes()[0]?.history).toHaveLength(1);

		const removed = await callTool(s, "memory_remove", { id: "editor-theme" });
		expect(removed.failed).toBe(false);
		expect(store.getNotes()[0]?.deletedAt).toBeTypeOf("number");
		// Soft, not gone: the live list hides it, `includeDeleted` shows it.
		expect((await callTool(s, "memory_list", {})).result).toBe(
			"No memories are stored.",
		);
		const deleted = await callTool(s, "memory_list", { includeDeleted: true });
		expect(deleted.result).toContain("editor-theme");
		expect(deleted.result).toContain("(removed)");

		// Revert undoes the removal...
		const restored = await callTool(s, "memory_revert", { id: "editor-theme" });
		expect(restored.failed).toBe(false);
		expect(store.getNotes()[0]?.deletedAt).toBeUndefined();
		// ...and the next call undoes the edit — one step per call.
		const stepped = await callTool(s, "memory_revert", { id: "editor-theme" });
		expect(stepped.failed).toBe(false);
		expect(store.getNotes()[0]?.content).toBe(
			"The user prefers a dark editor.",
		);
	});

	test("a refusal is a failed outcome carrying T1's own message, and the turn survives", async () => {
		const s = services();
		const store = makeSource();
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			store.source,
		).apply();
		await callTool(s, "memory_add", { id: "note", content: "first" });

		// The expected text is computed from T1 over the same store, so the tool
		// cannot drift into a second, reworded refusal copy.
		const expected = addMemory(store.getNotes(), "note", "second", 0);
		expect(expected.ok).toBe(false);
		const refused = await callTool(s, "memory_add", {
			id: "note",
			content: "second",
		});
		expect(refused.failed).toBe(true);
		expect(refused.result).toBe(expected.ok ? "" : expected.message);
		// The store is untouched by the refusal...
		expect(store.getNotes()[0]?.content).toBe("first");
		// ...and the turn is alive: the next call still executes.
		expect((await callTool(s, "memory_list", {})).failed).toBe(false);
	});

	test("a memory tool whose executor throws is a failed outcome, not a defect", async () => {
		const s = services();
		const store = makeSource();
		// The fault is the tool's own body: the write the executor makes throws.
		const throwing: MemorySettingsSource = {
			...store.source,
			saveNotes: () => {
				throw new Error("the store is on fire");
			},
		};
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			throwing,
		).apply();

		const logged = spyOn(console, "log");
		const outcome = await callTool(s, "memory_add", {
			id: "note",
			content: "x",
		});
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(outcome.failed).toBe(true);
		expect(typeof outcome.result).toBe("string");
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
		// The turn survived: a tool that never touches the throw still runs.
		expect((await callTool(s, "memory_list", {})).failed).toBe(false);
	});

	test("a tool whose executor throws alongside them leaves the registry usable", async () => {
		const s = services();
		const { source } = makeSource();
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			source,
		).apply();
		const exploding: Tool = {
			declaration: {
				name: "explode",
				description: "Always throws.",
				parameters: { type: "object" },
			},
			execute: () => {
				throw new Error("boom");
			},
		};
		registerTool(makeHost(s, "acme.tools", scope()), exploding, "acme.tools");

		const logged = spyOn(console, "log");
		const outcome = await callTool(s, "explode", {});
		logged.mockRestore();

		expect(outcome.failed).toBe(true);
		expect(typeof outcome.result).toBe("string");
		expect(toolIds(s)).toContain("memory_add");
		expect((await callTool(s, "memory_list", {})).failed).toBe(false);
	});
});

describe("the enablement gate", () => {
	test("with memory off, none of the five is registered", () => {
		const s = services();
		const store = makeSource([], false);
		makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			store.source,
		).apply();

		expect(toolIds(s)).toEqual([]);
	});

	test("toggling memory off after registration unregisters all five", async () => {
		const s = services();
		const store = makeSource();
		const registration = makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			store.source,
		);
		registration.apply();
		registration.watch();
		expect(toolIds(s)).toHaveLength(5);

		store.setEnabled(false);
		store.emit();

		// Absent from the registry, which is what keeps them off the wire...
		expect(toolIds(s)).toEqual([]);
		// ...so the call itself reports an unregistered tool, not a refusal.
		const outcome = await callTool(s, "memory_add", {
			id: "note",
			content: "x",
		});
		expect(outcome.failed).toBe(true);
		expect(outcome.result).toBe("No tool named memory_add is registered.");

		// And back on: the reverse toggle registers them again.
		store.setEnabled(true);
		store.emit();
		expect(toolIds(s)).toHaveLength(5);
	});

	test("watching twice stops cleanly: the stop unsubscribes and unregisters", () => {
		const s = services();
		const store = makeSource();
		const registration = makeMemoryToolRegistration(
			makeHost(s, "app.memory", scope()),
			store.source,
		);
		registration.apply();
		const stop = registration.watch();
		expect(toolIds(s)).toHaveLength(5);

		stop();
		expect(toolIds(s)).toEqual([]);
		// A notification after the stop must not resurrect them.
		store.emit();
		expect(toolIds(s)).toEqual([]);
		expect(() => stop()).not.toThrow();
	});
});

describe("the app.memory area", () => {
	test("the app's own source reads the settings store", () => {
		// The production seam is the reachable one: the same settings store the
		// UI reads, so a tool write is visible to React and a UI toggle is seen
		// by the tool gate.
		expect(typeof appMemorySettings.enabled()).toBe("boolean");
		expect(Array.isArray(appMemorySettings.notes())).toBe(true);
		expect(typeof appMemorySettings.subscribe).toBe("function");
	});

	test("the table has eleven toggleable areas, and app.memory is the tenth", () => {
		// Eleven **toggleable** areas, the plan's count: the table carries two
		// more entries because the substrate and the manager are locked.
		expect(BUILTIN_AREAS.filter((area) => area.locked !== true)).toHaveLength(
			11,
		);
		expect(BUILTIN_AREAS).toHaveLength(BUILTIN_IDENTITIES.length);
		expect(BUILTIN_IDENTITIES.map((identity) => identity.id)).toContain(
			"app.memory",
		);
		const area = BUILTIN_AREAS.find(
			(candidate) => candidate.id === "app.memory",
		);
		expect(typeof area?.register).toBe("function");
	});

	test("app.memory reconciles its five tools, and closing the area removes them", async () => {
		const s = services();
		const enabled = new Set<string>(["app.memory"]);
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => enabled.has(areaId),
			contributionEnabledOf: () => true,
			makeHost,
		});

		await Effect.runPromise(reconciler.reconcile(s));
		expect(toolIds(s)).toEqual([
			"memory_add",
			"memory_list",
			"memory_remove",
			"memory_revert",
			"memory_update",
		]);

		// Turning the area off is a close of its scope, and that is what removes
		// its contributions.
		enabled.clear();
		await Effect.runPromise(reconciler.reconcile(s));
		expect(toolIds(s)).toEqual([]);

		// `registerMemoryBuiltins` on its own is the same path the table takes.
		const host = makeHost(s, "app.memory", scope());
		registerMemoryBuiltins(host);
		expect(toolIds(s)).toHaveLength(5);
	});
});
