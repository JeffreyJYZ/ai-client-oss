import { registerCommandBuiltins } from "@lib/plugins/builtin/commands";
import { registerComposerBuiltins } from "@lib/plugins/builtin/composer";
import { registerOverlayBuiltins } from "@lib/plugins/builtin/overlay";
import { registerProviderBuiltins } from "@lib/plugins/builtin/providers";
import { registerSettingsBuiltins } from "@lib/plugins/builtin/settings";
import { registerShellBuiltins } from "@lib/plugins/builtin/shell";
import { registerThemeBuiltins } from "@lib/plugins/builtin/themes";
import { registerToolBuiltins } from "@lib/plugins/builtin/tools";
import { registerTranscriptBuiltins } from "@lib/plugins/builtin/transcript";
import type { Host } from "@lib/plugins/host";

/**
 * The built-in area table (spec "Units and identities"): one named, individually
 * toggleable unit per existing registrar, plus the locked core.
 *
 * Every later task reads this table rather than a second list: Task 3 registers
 * and reconciles `area.register` per area, Task 5 renders one row per area, and
 * `areas.test.ts` proves the table covers every `register*Builtins` export
 * under `builtin/**`, so a tenth built-in cannot land untoggleable.
 *
 * Areas are ordered as the registrar aggregator called them, so registration
 * order (the last tie-break in slot resolution) is preserved when Task 3 walks
 * this array. The two locked entries sit at the edges: the substrate first, the
 * manager last, which is also the order `LOCKED_BUILTIN_IDS` derives.
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

/** One named built-in area: what it is, what it does, and whether it can be turned off. */
export interface BuiltinArea {
	/** Stable id, matching {@link BUILTIN_ID_PATTERN} (`app.shell`). */
	readonly id: string;
	/** Human name for the Plugins section's row. */
	readonly label: string;
	/** One sentence stating what disappears when the area is off. */
	readonly description: string;
	/** Locked areas can never be disabled, and the bare preset leaves them on. */
	readonly locked?: boolean;
	/** The area's existing registrar, called with a host built for this area. */
	readonly register: (host: Host) => void;
}

/**
 * The built-in areas, in registration order — except the two locked entries,
 * which bracket the list (substrate first, manager last).
 */
export const BUILTIN_AREAS: readonly BuiltinArea[] = [
	{
		id: "app.substrate",
		label: "App container",
		description:
			"The container that hosts a layout; it stays on so there is always a surface for the rest of the app to render into.",
		locked: true,
		register: () => {
			// Deliberately empty in this task: Task 3 gives the substrate its
			// meaning — the container the registration/reconcile lifecycle owns.
			// Today every area registers through the one host `main.tsx` builds,
			// so the substrate has nothing of its own to register, and a non-empty
			// body would double-register another area's contributions.
		},
	},
	{
		id: "app.shell",
		label: "Shell",
		description:
			"The default layout, header and notice strips — with this off the container is left empty, which is the intended bare-host state, not a broken app.",
		register: registerShellBuiltins,
	},
	{
		id: "app.transcript",
		label: "Transcript",
		description: "The chat pane, its message list and the message renderers.",
		register: registerTranscriptBuiltins,
	},
	{
		id: "app.composer",
		label: "Composer",
		description:
			"The message composer, its toolbar and its send and stop controls.",
		register: registerComposerBuiltins,
	},
	{
		id: "app.settings",
		label: "Settings",
		description:
			"The Settings page, its sections and the conversation sidebar.",
		register: registerSettingsBuiltins,
	},
	{
		id: "app.tools",
		label: "Built-in tools",
		description:
			"The built-in tools the model can call, such as fetch_url and web search.",
		register: registerToolBuiltins,
	},
	{
		id: "app.providers",
		label: "Providers",
		description:
			"The built-in provider protocols that talk to the model endpoints.",
		register: registerProviderBuiltins,
	},
	{
		id: "app.commands",
		label: "Commands",
		description:
			"The built-in commands, their keybindings and the command palette.",
		register: registerCommandBuiltins,
	},
	{
		id: "app.themes",
		label: "Themes",
		description: "The built-in themes and the app's theme service.",
		register: registerThemeBuiltins,
	},
	{
		id: "app.overlay",
		label: "Overlays",
		description: "The toast stack and the modal surface.",
		register: registerOverlayBuiltins,
	},
	{
		id: "app.builtins",
		label: "Plugins manager",
		description:
			"The Plugins manager section; it stays on because it is the way back to this list.",
		locked: true,
		register: () => {
			// Deliberately empty in this task: the Plugins section is registered
			// inside `registerSettingsBuiltins` (`builtin/settings.ts`) as the
			// `settings.section.plugins` contribution, and that registrar is not
			// this task's file to split. Registering it again here would duplicate
			// the section. Task 2/5 consume the id; if a later task extracts the
			// section, its registration moves into this body.
		},
	},
];

/**
 * The ids that can never be disabled — derived from the table's `locked` flags
 * so the set has one source (Task 2 refuses a toggle on these, Task 5 disables
 * their UI control). Order follows {@link BUILTIN_AREAS}.
 */
export const LOCKED_BUILTIN_IDS: readonly string[] = BUILTIN_AREAS.filter(
	(area) => area.locked === true,
).map((area) => area.id);
