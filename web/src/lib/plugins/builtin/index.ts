import { registerComposerBuiltins } from "@lib/plugins/builtin/composer";
import { registerSettingsBuiltins } from "@lib/plugins/builtin/settings";
import { registerShellBuiltins } from "@lib/plugins/builtin/shell";
import { registerTranscriptBuiltins } from "@lib/plugins/builtin/transcript";
import type { Host } from "@lib/plugins/host";

/**
 * Register every built-in contribution (spec §3/§12). One call per area, in a
 * fixed order, so registration order — the last tie-break in slot resolution —
 * is deterministic, and each area owns exactly one file: Tasks 6–9 each fill
 * one of the four registrars and never touch a shared file.
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
};
