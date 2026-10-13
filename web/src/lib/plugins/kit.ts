import * as uiKit from "@/ui/kit";
import Markdown from "@/ui/Markdown";

/**
 * The component kit a plugin reaches as `host.ui.kit` (spec §4): the app's own
 * primitives, re-exported here rather than re-implemented, so plugin UI is
 * visually consistent without copying Tailwind strings.
 *
 * **This is a curated re-export, not a second kit.** Every value below is the
 * very object `ui/kit` and `ui/Markdown` export — identity, not equivalence —
 * so a plugin composing `host.ui.kit.Button` renders the app's `Button`, on the
 * app's React instance (the build preset maps the plugin's `react` import onto
 * the host's `__aiClientReact`). A list here, rather than `export *`, keeps the
 * plugin-facing subset explicit: anything added to `ui/kit` for the app's own
 * use does not silently become plugin API.
 *
 * Deliberately **not** exposed: nothing in `ui/kit` takes a slot or a registry
 * handle, so the whole kit is safe to hand over. The class-string constants
 * are included because "without copying Tailwind strings" is the point, and a
 * `FieldRow` needs an `INPUT` for its control. A component that took a
 * `SlotId`/registry handle a plugin cannot supply would stay out.
 */

/** The kit as a plugin sees it (spec §4's `ui.kit`). */
export interface PluginKit {
	readonly Button: typeof uiKit.Button;
	readonly Panel: typeof uiKit.Panel;
	readonly Section: typeof uiKit.Section;
	readonly FieldRow: typeof uiKit.FieldRow;
	/** The app's markdown renderer (sanitized model output). */
	readonly Markdown: typeof Markdown;
	/** Join class names, dropping the falsy ones. */
	readonly cls: typeof uiKit.cls;
	readonly INPUT: string;
	readonly LABEL: string;
	readonly BUTTON: string;
	readonly BUTTON_PLAIN: string;
	readonly CONTROL: string;
}

/**
 * The one kit object the host hands every plugin. A single module-level value,
 * so two plugins (and the built-ins) share one identity — a per-plugin copy
 * could drift the moment the kit is billed as "the app's own".
 */
export const pluginKit: PluginKit = {
	Button: uiKit.Button,
	Panel: uiKit.Panel,
	Section: uiKit.Section,
	FieldRow: uiKit.FieldRow,
	Markdown,
	cls: uiKit.cls,
	INPUT: uiKit.INPUT,
	LABEL: uiKit.LABEL,
	BUTTON: uiKit.BUTTON,
	BUTTON_PLAIN: uiKit.BUTTON_PLAIN,
	CONTROL: uiKit.CONTROL,
};
