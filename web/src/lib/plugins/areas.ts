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
 * owns. Today every area registers through the one host `main.tsx` builds, so
 * the substrate has nothing of its own to register, and a non-empty body would
 * double-register another area's contributions.
 */
const registerSubstrate = (): void => {};

/**
 * The manager's registrar. Deliberately empty **until Task 5**, which extracts
 * the Plugins section's registration into it.
 *
 * The extraction is a settled controller ruling, not an option: today the
 * manager's registration is one inline `host.ui.register({ id:
 * "settings.section.plugins", … })` inside `registerSettingsBuiltins`
 * (`builtin/settings.ts`), so it rides `app.settings` — the area that is
 * toggleable — and this area's lock therefore protects nothing at contribution
 * level. Until Task 5 moves that registration here, turning `app.settings` off
 * takes the manager with it, and the spec's "there is always a way back" would
 * depend on the UI alone.
 */
const registerManager = (): void => {};

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
