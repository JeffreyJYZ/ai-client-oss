import { describe, expect, spyOn, test } from "bun:test";
import {
	type Command,
	type CommandDefinition,
	filterCommands,
	listCommands,
	matchKeybinding,
	registerCommand,
	resolveKeybinding,
	runCommand,
} from "@lib/plugins/commands";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { Effect, Option, Scope } from "effect";

/**
 * A fresh registry set per test: registrations are the subject, so a shared
 * `HostServices` would leak commands between tests (the `tools.test.ts`
 * pattern). No DOM: `matchKeybinding` is a pure function over a structural
 * event, and the palette/global-handler behaviour is the browser proof's job.
 */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const host = (s: HostServicesShape, id: string): ReturnType<typeof makeHost> =>
	makeHost(s, id, scope());

/** Run a registry-reading effect against one test's services. */
const runWith = <A, E>(
	effect: Effect.Effect<A, E, HostServices>,
	s: HostServicesShape,
): Promise<A> =>
	Effect.runPromise(Effect.provideService(effect, HostServices, s));

/** Read the commands registry synchronously, as the registrar does. */
const read = (s: HostServicesShape): readonly Command[] =>
	Effect.runSync(Effect.provideService(listCommands(), HostServices, s));

/** A command definition with a no-op body unless one is supplied. */
const definition = (
	id: string,
	extra: Partial<Pick<CommandDefinition, "keybinding" | "run">> = {},
): CommandDefinition => ({
	id,
	title: `Title ${id}`,
	run: () => {},
	...extra,
});

/** The `PluginFault`s a block logged, with the spy restored. */
const faultsFrom = (block: () => void): readonly PluginFault[] => {
	const logged = spyOn(console, "log");
	try {
		block();
		return logged.mock.calls
			.flat()
			.filter((value): value is PluginFault => value instanceof PluginFault);
	} finally {
		logged.mockRestore();
	}
};

interface KeyInit {
	readonly key: string;
	readonly metaKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly shiftKey?: boolean;
	readonly altKey?: boolean;
	readonly target?: unknown;
}

/**
 * A structural `KeyboardEvent`: `matchKeybinding` reads only these fields, and
 * bun's runner has no DOM, so a plain object is the honest input.
 */
const ev = (init: KeyInit): KeyboardEvent =>
	({
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		target: null,
		...init,
	}) as unknown as KeyboardEvent;

const bindingOf = (event: KeyInit): string | null =>
	Option.getOrNull(matchKeybinding(ev(event)));

describe("commands registry", () => {
	test("lists commands in registration order and stamps the owner", () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, definition("beta"));
		registerCommand(h, definition("alpha"));

		const commands = read(s);
		expect(commands.map((command) => command.id)).toEqual(["beta", "alpha"]);
		expect(commands.map((command) => command.owner)).toEqual([
			"app.builtin",
			"app.builtin",
		]);
	});

	test("a duplicate id is replaced in place — later wins — and logs", () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, { id: "dup", title: "first", run: () => {} });
		const faults = faultsFrom(() => {
			registerCommand(h, { id: "dup", title: "second", run: () => {} });
		});

		expect(read(s).map((command) => command.title)).toEqual(["second"]);
		expect(faults.some((fault) => fault.detail.includes("dup"))).toBe(true);
	});

	test("a duplicate keybinding — later wins — and logs", async () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, { ...definition("one"), keybinding: "mod+k" });
		const faults = faultsFrom(() => {
			registerCommand(h, { ...definition("two"), keybinding: "mod+k" });
		});

		// Later wins at resolve time; the earlier command still exists.
		expect(Option.getOrNull(await runWith(resolveKeybinding("mod+k"), s))).toBe(
			"two",
		);
		expect(read(s).map((command) => command.id)).toEqual(["one", "two"]);
		expect(faults.some((fault) => fault.detail.includes("mod+k"))).toBe(true);
	});

	test("keybindings are canonicalised on registration, so spellings collide", async () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, { ...definition("one"), keybinding: "Meta+K" });
		const faults = faultsFrom(() => {
			registerCommand(h, { ...definition("two"), keybinding: "ctrl+k" });
		});

		// "Meta+K" and "ctrl+k" are one binding once canonicalised, so the
		// second collides: it logs, and it is what the binding resolves to.
		expect(read(s).map((command) => command.keybinding)).toEqual([
			"mod+k",
			"mod+k",
		]);
		expect(faults.some((fault) => fault.detail.includes("mod+k"))).toBe(true);
		expect(
			Option.getOrNull(await runWith(resolveKeybinding("Meta+K"), s)),
		).toBe("two");
	});

	test("an invalid definition is refused with a logged PluginFault and leaves no entry", () => {
		const s = services();
		const h = host(s, "app.builtin");
		const faults = faultsFrom(() => {
			registerCommand(h, { id: "", title: "", run: () => {} });
		});

		expect(read(s)).toHaveLength(0);
		expect(faults).toHaveLength(1);
		expect(faults[0]?.detail).toContain("invalid");
	});

	test("a missing id resolves to none, never a throw", async () => {
		const s = services();
		const resolved = await runWith(resolveKeybinding("mod+k"), s);
		expect(Option.isNone(resolved)).toBe(true);
	});
});

describe("runCommand", () => {
	test("runs the command's effect", async () => {
		const s = services();
		let ran = 0;
		registerCommand(host(s, "app.builtin"), {
			...definition("go"),
			run: () => {
				ran += 1;
			},
		});

		await runWith(runCommand("go"), s);
		expect(ran).toBe(1);
	});

	test("an unknown id logs a fault and does not reject", async () => {
		const s = services();
		await expect(runWith(runCommand("nope"), s)).resolves.toBeUndefined();
	});

	test("a throwing command is isolated, not an exception out of the loop", async () => {
		const s = services();
		registerCommand(host(s, "acme.command"), {
			...definition("boom"),
			run: () => {
				throw new Error("boom");
			},
		});

		await expect(runWith(runCommand("boom"), s)).resolves.toBeUndefined();
	});
});

describe("matchKeybinding", () => {
	test("normalises Meta and Ctrl to the one platform-agnostic modifier", () => {
		expect(bindingOf({ key: "k", metaKey: true })).toBe("mod+k");
		expect(bindingOf({ key: "k", ctrlKey: true })).toBe("mod+k");
	});

	test("normalises Shift and Alt, and lowercases the key", () => {
		expect(bindingOf({ key: "K", metaKey: true, shiftKey: true })).toBe(
			"mod+shift+k",
		);
		expect(bindingOf({ key: "K", metaKey: true, altKey: true })).toBe(
			"mod+alt+k",
		);
		expect(
			bindingOf({ key: "K", metaKey: true, altKey: true, shiftKey: true }),
		).toBe("mod+shift+alt+k");
	});

	test("a bare key is a binding shape (nothing fires unless something binds it)", () => {
		expect(bindingOf({ key: "c" })).toBe("c");
	});

	test("ignores keystrokes typed into an input, a textarea, or contentEditable", () => {
		expect(bindingOf({ key: "c", target: { tagName: "INPUT" } })).toBeNull();
		expect(bindingOf({ key: "c", target: { tagName: "TEXTAREA" } })).toBeNull();
		expect(bindingOf({ key: "c", target: { tagName: "input" } })).toBeNull();
		expect(
			bindingOf({ key: "k", metaKey: true, target: { tagName: "INPUT" } }),
		).toBeNull();
		expect(
			bindingOf({ key: "c", target: { isContentEditable: true } }),
		).toBeNull();
	});

	test("a modifier key on its own is not a binding", () => {
		expect(bindingOf({ key: "Meta", metaKey: true })).toBeNull();
		expect(bindingOf({ key: "Shift", shiftKey: true })).toBeNull();
		expect(bindingOf({ key: "" })).toBeNull();
	});
});

describe("filterCommands", () => {
	test("an empty query lists every command", () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, { ...definition("app.chat.new"), title: "New chat" });
		registerCommand(h, {
			...definition("app.backup.export"),
			title: "Export backup",
		});
		const commands = read(s);

		expect(filterCommands(commands, "")).toHaveLength(2);
		expect(filterCommands(commands, "   ")).toHaveLength(2);
	});

	test("matches the title or the id, case-insensitively", () => {
		const s = services();
		const h = host(s, "app.builtin");
		registerCommand(h, { ...definition("app.chat.new"), title: "New chat" });
		registerCommand(h, {
			...definition("app.backup.export"),
			title: "Export backup",
		});
		const commands = read(s);

		expect(filterCommands(commands, "CHAT").map((c) => c.id)).toEqual([
			"app.chat.new",
		]);
		expect(filterCommands(commands, "backup").map((c) => c.id)).toEqual([
			"app.backup.export",
		]);
		expect(filterCommands(commands, "app.chat")).toHaveLength(1);
		expect(filterCommands(commands, "nothing")).toHaveLength(0);
	});
});
