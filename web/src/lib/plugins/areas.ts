import { registerCommandBuiltins } from "@lib/plugins/builtin/commands";
import { registerComposerBuiltins } from "@lib/plugins/builtin/composer";
import { registerMemoryBuiltins } from "@lib/plugins/builtin/memory";
import { registerOverlayBuiltins } from "@lib/plugins/builtin/overlay";
import { registerProviderBuiltins } from "@lib/plugins/builtin/providers";
import { registerSettingsBuiltins } from "@lib/plugins/builtin/settings";
import { registerShellBuiltins } from "@lib/plugins/builtin/shell";
import { registerThemeBuiltins } from "@lib/plugins/builtin/themes";
import { registerTitlerBuiltins } from "@lib/plugins/builtin/titler";
import { registerToolBuiltins } from "@lib/plugins/builtin/tools";
import { registerTranscriptBuiltins } from "@lib/plugins/builtin/transcript";
import {
	BUILTIN_IDENTITIES,
	type BuiltinId,
	type BuiltinIdentity,
} from "@lib/plugins/builtinIdentity";
import type { Host } from "@lib/plugins/host";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { PluginsSection } from "@/ui/plugins/PluginsSection";
import { SettingsShell } from "@/ui/Settings";

/**
 * The built-in area table (spec "Units and identities"): one named, individually
 * toggleable unit per existing registrar, plus the locked core.
 *
 * Every later task reads this table rather than a second list: Task 3 registers
 * and reconciles `area.register` per area, Task 5 renders one row per area, and
 * `areas.test.ts` proves the table covers every `register*Builtins` export under
 * `builtin/**`, so a tenth built-in cannot land untoggleable.
 *
 * **The identities live in `builtinIdentity.ts`**, a leaf module importing
 * nothing, because this file imports every registrar and `state/builtins.ts`
 * (which the Plugins section reads) must not: reaching the ids through here would
 * make the section import the store that the store would import back — a cycle
 * into a module with an import-time side effect. Here the identities are paired
 * with their registrars, in the identities' own order, so registration order (the
 * last tie-break in slot resolution) is preserved when Task 3 walks this array.
 */

export {
	BUILTIN_ID_PATTERN,
	BUILTIN_IDENTITIES,
	type BuiltinId,
	type BuiltinIdentity,
	LOCKED_BUILTIN_IDS,
} from "@lib/plugins/builtinIdentity";

/** One named built-in area: the identity above, plus the registrar it names. */
export interface BuiltinArea extends BuiltinIdentity {
	/** The area's existing registrar, called with a host built for this area. */
	readonly register: (host: Host) => void;
}

/**
 * The substrate's registrar: the settings **surface** (`settings.root`).
 *
 * Why the surface is the container's rather than the settings area's: every
 * settings section renders into that surface, the Plugins manager's own section
 * included (which rides the locked `app.builtins`), so the surface is part of
 * the way back. Locking it costs exactly one thing — the ability to make the
 * whole settings surface unreachable, which is the bug rather than a
 * customisation. The **sections** stay `app.settings`' to toggle, so the
 * drill-down loses nothing.
 *
 * This is the same move {@link registerManager} makes for the manager's
 * section, one level along, and for the same reason: the route back is not
 * owned by the area it returns from. Together they are what makes the manager
 * reachable in both states that used to lose it — with the shell off (the
 * container's own surface, `ui/MinimalHost.tsx`) and with `app.settings` off
 * (this surface, which carries the manager's section).
 *
 * The entry is byte-for-byte what `registerSettingsBuiltins` used to register —
 * the id, the slot, `SettingsShell` and `order: 10` — so the settings page
 * renders exactly where it did, and resolution (order, then priority, then
 * registration order) is unchanged.
 */
const registerSubstrate = (host: Host): void => {
	host.ui.register({
		id: "settings.root.shell",
		slot: "settings.root",
		component: SettingsShell,
		order: 10,
	});
};

/**
 * The manager's registrar: the Plugins section itself.
 *
 * The registration was extracted here from `registerSettingsBuiltins`
 * (`builtin/settings.ts`), where one inline `host.ui.register({ id:
 * "settings.section.plugins", … })` made the manager ride `app.settings` — the
 * toggleable area. Under that area the lock protected nothing at contribution
 * level: turning `app.settings` off took the manager with it, so the spec's
 * "there is always a way back" depended on the UI alone. Registering it here
 * puts it under the locked `app.builtins` area, whose gated host is the one the
 * locked core actually holds.
 *
 * The id, slot, component and `order: 100` are byte-for-byte what
 * `registerSettingsBuiltins` registered, so the section renders last in
 * `settings.sections`, as the same `PluginsSection` component, exactly where it
 * was.
 */
const registerManager = (host: Host): void => {
	host.ui.register({
		id: SETTINGS_SECTIONS.plugins.id,
		slot: "settings.sections",
		component: PluginsSection,
		order: 100,
	});
};

/**
 * One registrar per area id. Typed by {@link BuiltinId}, so adding an identity
 * without a registrar is a compile error rather than a silently empty area.
 */
const registrars: Record<BuiltinId, (host: Host) => void> = {
	"app.substrate": registerSubstrate,
	"app.shell": registerShellBuiltins,
	"app.transcript": registerTranscriptBuiltins,
	"app.composer": registerComposerBuiltins,
	"app.settings": registerSettingsBuiltins,
	"app.tools": registerToolBuiltins,
	"app.providers": registerProviderBuiltins,
	"app.commands": registerCommandBuiltins,
	"app.themes": registerThemeBuiltins,
	"app.overlay": registerOverlayBuiltins,
	"app.memory": registerMemoryBuiltins,
	"app.titler": registerTitlerBuiltins,
	"app.builtins": registerManager,
};

/**
 * The built-in areas, in registration order — except the two locked entries,
 * which bracket the list (substrate first, manager last).
 */
export const BUILTIN_AREAS: readonly BuiltinArea[] = BUILTIN_IDENTITIES.map(
	(identity) => ({ ...identity, register: registrars[identity.id] }),
);
