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
 * Register every built-in contribution (spec §3/§12). One call per area, in a
 * fixed order, so registration order — the last tie-break in slot resolution —
 * is deterministic, and each area owns exactly one file: Tasks 6–9 fill the
 * four UI area registrars and Tasks 10–15 the Phase 2 ones (tools, providers,
 * commands, themes, overlay), and none of them ever touches this shared file.
 *
 * The Phase 2 seams were created empty before their tasks ran (controller
 * ruling R19, the same pattern the UI areas used), which is what keeps the tree
 * compiling while an area is unfilled and keeps this file single-writer.
 *
 * The `host` is the one built for the built-in plugin, so every entry is owned
 * and disposed through the same path a third-party plugin's would be. Task 6
 * calls this from `main.tsx`, after building the runtime and before React
 * mounts.
 */
export const registerBuiltins = (host: Host): void => {
	registerShellBuiltins(host);
	registerTranscriptBuiltins(host);
	registerComposerBuiltins(host);
	registerSettingsBuiltins(host);
	registerToolBuiltins(host);
	registerProviderBuiltins(host);
	registerCommandBuiltins(host);
	registerThemeBuiltins(host);
	registerOverlayBuiltins(host);
};
