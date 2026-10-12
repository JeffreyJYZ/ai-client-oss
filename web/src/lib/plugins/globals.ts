import type { Host } from "@lib/plugins/host";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";

/**
 * The global names the build preset (`scripts/build-plugins.ts`) maps a
 * plugin's `react` and `react/jsx-runtime` imports onto (spec §6). They live
 * here, not in the script, so the setter below and the preset's `output.globals`
 * cannot drift: the script imports this object.
 */
export const hostGlobalNames = {
	/** The plugin API — the per-plugin `Host` a module reads as `globalThis.__aiClient`. */
	host: "__aiClient",
	react: "__aiClientReact",
	jsxRuntime: "__aiClientJsxRuntime",
} as const;

/**
 * Publish the host's shared modules on `globalThis` (spec §6). A plugin's entry
 * is one pre-built ES module with no imports, so React and the API reach it
 * through globals — and they must be set **before** the module is imported: a
 * module body that reads a global at evaluation time gets nothing otherwise.
 * `moduleImport.ts` calls this immediately before `import(url)`.
 */
export const setHostGlobals = (host: Host): void => {
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[hostGlobalNames.host] = host;
	globals[hostGlobalNames.react] = React;
	globals[hostGlobalNames.jsxRuntime] = jsxRuntime;
};
