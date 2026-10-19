/**
 * The built-in areas' identity data — the id allowlist, the names shown, the
 * one-line descriptions and the locked flags — and **nothing else**: no import,
 * no registrar, no side effect.
 *
 * Why it is a leaf module: `areas.ts` pairs each of these identities with its
 * registrar, and the registrars import the app's UI and the chat store.
 * `state/builtins.ts` — the store the Plugins section reads through
 * `useBuiltins` — needs the identities, and if it reached them *through*
 * `areas.ts` the section would import the store that imports the section: a
 * cycle into a module that starts itself at import. So the table's identity
 * lives here and the registration table lives in `areas.ts`; the store and the
 * UI import this file alone (spec "Units and identities").
 *
 * The coverage test in `areas.test.ts` scans `builtin/**` for `register…Builtins`
 * exports, so this file — outside `builtin/` and carrying no registrar — is
 * invisible to it and can never mask a registrar. That is asserted there.
 */

/**
 * The id an area must have. An **allowlist** in the same spirit as the plugin
 * id rule, but deliberately its own schema: the plugin rule allowlists a single
 * filesystem path component (the containment bug it was written after), and its
 * ids may carry interior dots (`acme.pipeline`). An area id names a UI region
 * and only ever indexes `Settings.builtins`, so it gets its own shape rather
 * than sharing that path guard. Rule: `app.` + a lowercase word.
 */
export const BUILTIN_ID_PATTERN = /^app\.[a-z][a-z0-9-]*$/;

/** One named built-in area's identity: what it is called and whether it can go off. */
export interface BuiltinIdentity {
	/** Stable id, matching {@link BUILTIN_ID_PATTERN} (`app.shell`). */
	readonly id: string;
	/** Human name for the Plugins section's row. */
	readonly label: string;
	/** One sentence stating what disappears when the area is off. */
	readonly description: string;
	/** Locked areas can never be disabled, and the bare preset leaves them on. */
	readonly locked?: boolean;
}

/**
 * The built-in identities, in registration order — except the two locked
 * entries, which bracket the list (substrate first, manager last).
 *
 * Every entry states `locked` explicitly, `false` included: the array is
 * `as const` so `BuiltinId` is the literal union of ids (which is what makes the
 * registrar map exhaustive at compile time), and a property that is *absent* on
 * some members cannot be read off that union (`identity.locked` would not
 * compile). Deleting one of these lines is therefore a type error, not a silent
 * default.
 */
export const BUILTIN_IDENTITIES = [
	{
		id: "app.substrate",
		label: "App container",
		// What it actually owns: `ui/App.tsx` is the container and
		// `ui/MinimalHost.tsx` is what it shows when no layout contribution is
		// present (the manager itself, plus what is off); its registrar also
		// registers the Settings **surface** (`settings.root.shell`), because every
		// section — the manager's included — renders into it, so the surface is
		// part of the way back. The row describes what the locked container
		// provides, not an abstract "surface for the rest of the app".
		description:
			"The container that hosts the app's layout and the Settings surface its sections render into; it stays on and shows a minimal surface with the Plugins manager when no layout is rendering.",
		locked: true,
	},
	{
		id: "app.shell",
		label: "Shell",
		// With the shell off the container does not go blank: `ui/MinimalHost.tsx`
		// renders the Plugins manager plus a line naming what is off (the
		// reachability fix), so the sentence must not claim an empty container.
		// The manager *is* the way back, so naming both would name one thing
		// twice.
		description:
			"The default layout, the header and the notice strips; with this off the container renders its minimal host surface instead: the Plugins manager and a line naming what is off.",
		locked: false,
	},
	{
		id: "app.transcript",
		label: "Transcript",
		description: "The chat pane, its message list and the message renderers.",
		locked: false,
	},
	{
		id: "app.composer",
		label: "Composer",
		description:
			"The message composer, its toolbar and its send and stop controls.",
		locked: false,
	},
	{
		id: "app.settings",
		label: "Settings",
		// The surface is not this area's: `settings.root.shell` rides the locked
		// `app.substrate` (and the Plugins manager rides `app.builtins`), so this
		// sentence must name only what this area still owns — the sections and the
		// sidebar — and must not claim the surface or the manager.
		description:
			"The Settings sections and the conversation sidebar; the surface they render into belongs to the app container, so turning this off never removes the way back to the Plugins manager.",
		locked: false,
	},
	{
		id: "app.tools",
		label: "Built-in tools",
		description:
			"The built-in tools the model can call, such as fetch_url and web search.",
		locked: false,
	},
	{
		id: "app.providers",
		label: "Providers",
		description:
			"The built-in provider protocols that talk to the model endpoints.",
		locked: false,
	},
	{
		id: "app.commands",
		label: "Commands",
		description:
			"The built-in commands, their keybindings and the command palette.",
		locked: false,
	},
	{
		id: "app.themes",
		label: "Themes",
		// What the registrar actually does: the one theme core is built in
		// `HostLayer` before any built-in runs, so this area contributes the
		// shipping dark theme, the app-internal handle that points at that core,
		// and the reconciliation fibre that puts the defaults back when an active
		// theme goes away.
		description:
			"The shipping dark theme, the app's theme handle and the reconciliation that restores the defaults when an active theme is removed.",
		locked: false,
	},
	{
		id: "app.overlay",
		label: "Overlays",
		description: "The toast stack and the modal surface.",
		locked: false,
	},
	{
		id: "app.memory",
		label: "Memory",
		// What the registrar owns: the Memory **settings section** (always, so
		// its switch is reachable) and the five tools (only while
		// `memoriesEnabled` is on, so "off" means absent from the registry).
		description:
			"The Memory settings section, the five memory tools, and the memory the model sends and records; with this off, all of it is gone.",
		locked: false,
	},
	{
		id: "app.titler",
		label: "Titler",
		// What the registrar owns: one scope-limited run per new conversation,
		// which asks the titler's own model for a title from the first message.
		// It contributes no registry entry of its own yet, so it is also the one
		// area with an empty catalog.
		description:
			"Names a new conversation from its first message using the titler's own model; with this off, that first message is never sent for a title.",
		locked: false,
	},
	{
		id: "app.builtins",
		label: "Plugins manager",
		// The registrar (`areas.ts` `registerManager`) registers
		// `settings.section.plugins` under this id, so the lock protects the
		// manager at contribution level: turning any other area off, the
		// Settings area included, cannot take away the way back.
		description:
			"The Plugins manager section; it stays on because it is the way back to this list.",
		locked: true,
	},
] as const satisfies readonly BuiltinIdentity[];

/** Every valid area id, derived from the one list above. */
export type BuiltinId = (typeof BUILTIN_IDENTITIES)[number]["id"];

/**
 * The ids that can never be disabled — derived from the identities' `locked`
 * flags so the set has one source (the store refuses a toggle on these, the UI
 * disables their control). Order follows {@link BUILTIN_IDENTITIES}.
 */
export const LOCKED_BUILTIN_IDS: readonly string[] = BUILTIN_IDENTITIES.filter(
	(identity) => identity.locked === true,
).map((identity) => identity.id);
