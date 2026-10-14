import { registerCommandBuiltins } from "@lib/plugins/builtin/commands";
import { registerComposerBuiltins } from "@lib/plugins/builtin/composer";
import { registerOverlayBuiltins } from "@lib/plugins/builtin/overlay";
import { registerProviderBuiltins } from "@lib/plugins/builtin/providers";
import { registerSettingsBuiltins } from "@lib/plugins/builtin/settings";
import { registerShellBuiltins } from "@lib/plugins/builtin/shell";
import { registerThemeBuiltins } from "@lib/plugins/builtin/themes";
import { registerToolBuiltins } from "@lib/plugins/builtin/tools";
import { registerTranscriptBuiltins } from "@lib/plugins/builtin/transcript";
import {
	BUILTIN_IDENTITIES,
	type BuiltinId,
	type BuiltinIdentity,
} from "@lib/plugins/builtinIdentity";
import type { Host } from "@lib/plugins/host";
import { PluginsSection } from "@/ui/plugins/PluginsSection";

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
 * The substrate's registrar. Deliberately empty in this task: Task 3 gives the
 * substrate its meaning — the container the registration/reconcile lifecycle
 * owns. Each area now registers through its own host, built per area by
 * `builtin/index.ts`, and the substrate still has nothing of its own to
 * register: a non-empty body would double-register another area's
 * contributions.
 */
const registerSubstrate = (): void => {};

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
		id: "settings.section.plugins",
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
	"app.builtins": registerManager,
};

/**
 * The built-in areas, in registration order — except the two locked entries,
 * which bracket the list (substrate first, manager last).
 */
export const BUILTIN_AREAS: readonly BuiltinArea[] = BUILTIN_IDENTITIES.map(
	(identity) => ({ ...identity, register: registrars[identity.id] }),
);
