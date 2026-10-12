import { PluginFault } from "@lib/plugins/errors";
import { type Host, HostServices } from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import { Effect, Option, Stream } from "effect";
import { z } from "zod";

/**
 * The command seam (spec §5): a command is an id, a title, the function that
 * performs it and an optional keybinding. Unlike a tool — whose name travels on
 * the wire to the model — a command is a UI affordance, so the conflict rules
 * are deliberately the opposite of `tools.ts`:
 *
 * - a duplicate command **id**: the later registration **wins** (the registry
 *   replaces it in place) and logs a warning;
 * - a duplicate **keybinding**: the later registration wins at resolve time and
 *   logs a warning.
 *
 * Do not "fix" this into the tool registry's first-wins refusal: a built-in that
 * a plugin means to override has to be overridable, and nothing downstream
 * depends on a command's identity the way the model depends on a tool's name.
 *
 * Storage is the host's own `commands` registry (`HostServices`), so a command
 * registered here is owned and disposed by the registering plugin's `Scope` —
 * the same lifetime every other contribution has. The binding index is derived
 * from the entries themselves rather than mirrored into `HostServices.keybindings`:
 * a command carries its own keybinding, and one source of truth is what keeps
 * "later wins" true for both rules without a second table to keep in step.
 */

/**
 * A command as a plugin declares it (spec §1: zod is the source of truth). The
 * value is plugin-supplied, untyped JavaScript at this boundary, so it is
 * validated before it is stored rather than trusted.
 */
export const commandSchema = z.object({
	/** The command's stable id — what `runCommand` and a keybinding resolve. */
	id: z.string().min(1),
	title: z.string().min(1),
	run: z.custom<() => void>((value) => typeof value === "function"),
	/** A keybinding in the canonical form `matchKeybinding` emits. */
	keybinding: z.string().min(1).optional(),
});

export type CommandDefinition = z.infer<typeof commandSchema>;

/**
 * A stored command: the definition plus the plugin that owns it. `owner` is
 * stamped by the host, never by the registrar's caller.
 */
export type Command = CommandDefinition & { readonly owner: string };

/**
 * Modifier spellings that mean the same thing, folded to the canonical tokens
 * `matchKeybinding` emits. `Meta` and `Ctrl` both become `mod`, so one
 * registered binding works on macOS and elsewhere; `Option` is macOS's `Alt`.
 */
const MODIFIER_ALIASES: Readonly<Record<string, "mod" | "shift" | "alt">> = {
	mod: "mod",
	meta: "mod",
	cmd: "mod",
	command: "mod",
	ctrl: "mod",
	control: "mod",
	shift: "shift",
	alt: "alt",
	option: "alt",
};

/** Canonical modifier order, so `shift+mod+k` and `mod+shift+k` are one binding. */
const MODIFIER_ORDER = ["mod", "shift", "alt"] as const;

/**
 * The one canonical form of a keybinding: lowercased, modifiers folded to
 * `mod`/`shift`/`alt`, ordered modifiers first. Both a registered binding and a
 * live event go through this, so the two can only agree or differ.
 */
export const normaliseKeybinding = (binding: string): string => {
	const parts = binding
		.split("+")
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part !== "");
	const keys = parts.filter((part) => MODIFIER_ALIASES[part] === undefined);
	const modifiers = MODIFIER_ORDER.filter((modifier) =>
		parts.some((part) => MODIFIER_ALIASES[part] === modifier),
	);
	return [...modifiers, ...keys].join("+");
};

/** Keys that are a modifier on their own, so they are never a binding. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
	"alt",
	"altgraph",
	"capslock",
	"control",
	"fn",
	"meta",
	"numlock",
	"shift",
]);

/**
 * Whether a keystroke was typed into a text surface. Duck-typed, not
 * `instanceof`: the test runner has no DOM, and the check is only ever about
 * these two facts. This is the guard that keeps a bare `c` typed into the
 * composer from firing a command.
 */
const isTypingTarget = (target: unknown): boolean => {
	if (target === null || typeof target !== "object") return false;
	const element = target as {
		readonly tagName?: unknown;
		readonly isContentEditable?: unknown;
	};
	const tag =
		typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
	return (
		tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable === true
	);
};

/**
 * The canonical keybinding one keydown event represents (spec §5), or `none`
 * when the event is not a binding: a keystroke typed into an `<input>`,
 * `<textarea>` or contentEditable surface, or a modifier pressed alone. It is a
 * pure function of the event — the caller pairs it with `resolveKeybinding`.
 */
export const matchKeybinding = (
	event: KeyboardEvent,
): Option.Option<string> => {
	if (isTypingTarget(event.target)) return Option.none();
	const key = typeof event.key === "string" ? event.key : "";
	if (key === "" || MODIFIER_KEYS.has(key.toLowerCase())) return Option.none();
	return Option.some(
		normaliseKeybinding(
			[
				event.metaKey || event.ctrlKey ? "mod" : "",
				event.shiftKey ? "shift" : "",
				event.altKey ? "alt" : "",
				key,
			]
				.filter((part) => part !== "")
				.join("+"),
		),
	);
};

/** The registry stores `Command`s, but `HostServices.commands` is the bare entry. */
const asCommand = (entry: RegistryEntry): Command => entry as Command;

/** The canonical binding an entry declares, when it declares one. */
const bindingOf = (entry: RegistryEntry): string | undefined => {
	const value = (entry as { readonly keybinding?: unknown }).keybinding;
	return typeof value === "string" ? normaliseKeybinding(value) : undefined;
};

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/**
 * A registration refused for a bad value is a logged `PluginFault`, never a
 * throw (spec §9): one command is dropped, the plugin and the app keep running.
 */
const warn = (detail: string, pluginId?: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

/**
 * Register `command` through `host` (spec §5). A duplicate id is handed to the
 * registry, whose own rule is replace-in-place plus a warning — later wins,
 * which is what a command wants. A keybinding already bound by another command
 * logs the same warning here; the later one wins because `resolveKeybinding`
 * takes the last match in registration order.
 */
export const registerCommand = (
	host: Host,
	definition: CommandDefinition,
	pluginId?: string,
): Disposable => {
	// Read defensively: the caller is untyped JavaScript at this boundary.
	const declared = definition as { readonly id?: unknown } | undefined;
	const parsed = commandSchema.safeParse(definition);
	if (!parsed.success) {
		warn(
			`the command "${String(declared?.id)}" is invalid: ${parsed.error.message}`,
			pluginId,
		);
		return noopDisposable;
	}
	const { id, title, run } = parsed.data;
	const keybinding =
		parsed.data.keybinding === undefined
			? undefined
			: normaliseKeybinding(parsed.data.keybinding);
	if (
		keybinding !== undefined &&
		Effect.runSync(host.commands.entries()).some(
			(entry) => bindingOf(entry) === keybinding,
		)
	) {
		warn(
			`keybinding "${keybinding}" is already bound; the later registration wins`,
			pluginId,
		);
	}
	const entry: Omit<Command, "owner"> = { id, title, run, keybinding };
	return host.commands.register(entry);
};

/** Every registered command, in resolution order. */
export const listCommands = (): Effect.Effect<
	readonly Command[],
	never,
	HostServices
> =>
	Effect.map(
		Effect.flatMap(HostServices, (services) => services.commands.entries()),
		(entries) => entries.map(asCommand),
	);

/** The registered command called `id`, or `none`. */
export const resolveCommand = (
	id: string,
): Effect.Effect<Option.Option<Command>, never, HostServices> =>
	Effect.map(listCommands(), (commands) => {
		const found = commands.find((command) => command.id === id);
		return found === undefined ? Option.none<Command>() : Option.some(found);
	});

/**
 * The id of the command bound to `binding`, or `none`. The **last** match in
 * `resolveOrder` wins, which is the second half of the duplicate-keybinding
 * rule (the warning is logged at registration) — though `resolveOrder` sorts an
 * explicit `order` ahead of the rest, so a raw `host.commands.register` carrying
 * one would never be that last match and would silently invert the rule;
 * `registerCommand` cannot, since a `CommandDefinition` has no such field.
 */
export const resolveKeybinding = (
	binding: string,
): Effect.Effect<Option.Option<string>, never, HostServices> => {
	const wanted = normaliseKeybinding(binding);
	return Effect.map(listCommands(), (commands) => {
		const matches = commands.filter(
			(command) =>
				command.keybinding !== undefined &&
				normaliseKeybinding(command.keybinding) === wanted,
		);
		const last = matches[matches.length - 1];
		return last === undefined ? Option.none<string>() : Option.some(last.id);
	});
};

/**
 * Run the command called `id` (spec §5). A missing id is a logged warning, and
 * a command that throws is caught here and logged, so one plugin's broken
 * command cannot take the key handler or the palette down with it.
 */
export const runCommand = (
	id: string,
): Effect.Effect<void, never, HostServices> =>
	Effect.gen(function* () {
		const command = yield* resolveCommand(id);
		if (Option.isNone(command)) {
			yield* Effect.logWarning(
				new PluginFault({
					detail: `no command is registered with id "${id}"; nothing ran`,
				}),
			);
			return;
		}
		const found = command.value;
		yield* Effect.try({
			try: () => found.run(),
			catch: (cause) => String(cause),
		}).pipe(
			Effect.catch((detail) =>
				Effect.logWarning(
					new PluginFault({
						detail: `command "${id}" threw: ${detail}`,
						pluginId: found.owner,
					}),
				),
			),
		);
	});

/**
 * The commands matching a palette query: a case-insensitive substring of the
 * title or the id, with an empty query listing everything. Pure, so the
 * palette's filtering is testable without a DOM.
 */
export const filterCommands = (
	commands: readonly Command[],
	query: string,
): readonly Command[] => {
	const needle = query.trim().toLowerCase();
	if (needle === "") return commands;
	return commands.filter(
		(command) =>
			command.title.toLowerCase().includes(needle) ||
			command.id.toLowerCase().includes(needle),
	);
};

/**
 * The React-facing snapshot of the `commands` registry, in the same
 * `useSyncExternalStore` shape as `lib/plugins/bridge.ts`: a module variable
 * replaced only by the bridge below, so `getCommandsSnapshot` returns the same
 * array until the registry actually mutates.
 */
let snapshot: readonly Command[] = [];

const snapshotListeners = new Set<() => void>();

export const getCommandsSnapshot = (): readonly Command[] => snapshot;

export const subscribeCommands = (listener: () => void): (() => void) => {
	snapshotListeners.add(listener);
	return () => {
		snapshotListeners.delete(listener);
	};
};

let bridgeInstalled = false;

/**
 * Fold the `commands` registry into the snapshot above, once per app. Seeded
 * synchronously so the first palette render already sees every built-in, then
 * kept in step by the registry's `changes` stream. Idempotent because React
 * StrictMode mounts effects twice in development.
 */
export const installCommandBridge = (): void => {
	if (bridgeInstalled) return;
	bridgeInstalled = true;
	snapshot = runtime.runSync(listCommands());
	runtime.runFork(
		Effect.gen(function* () {
			const services = yield* HostServices;
			yield* Stream.runForEach(services.commands.changes, (entries) =>
				Effect.sync(() => {
					snapshot = entries.map(asCommand);
					for (const listener of snapshotListeners) listener();
				}),
			);
		}),
	);
};
