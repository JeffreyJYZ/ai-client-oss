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
		description:
			"The container that hosts a layout; it stays on so there is always a surface for the rest of the app to render into.",
		locked: true,
	},
	{
		id: "app.shell",
		label: "Shell",
		description:
			"The default layout, header and notice strips — with this off the container is left empty, which is the intended bare-host state, not a broken app.",
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
		// The Plugins manager section rides inside this area today (registered
		// inline by `registerSettingsBuiltins`), so the sentence names it. Task 5
		// extracts it into `app.builtins` — a settled controller ruling, not an
		// option, because otherwise turning this area off would take away the way
		// back, which the spec forbids.
		description:
			"The Settings page, its sections, the conversation sidebar and the Plugins manager section that still rides inside the page.",
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
		id: "app.builtins",
		label: "Plugins manager",
		// The manager's registration is settled to move here in Task 5, from the
		// inline `settings.section.plugins` inside `registerSettingsBuiltins`.
		// Until that lands this lock protects nothing at contribution level: the
		// manager still rides `app.settings`, so turning that area off takes the
		// manager with it.
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
