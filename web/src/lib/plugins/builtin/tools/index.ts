import { fetchUrlBuiltin } from "@lib/plugins/builtin/tools/fetchUrl";
import { webSearchBuiltin } from "@lib/plugins/builtin/tools/webSearch";
import type { Host } from "@lib/plugins/host";
import { registerTool } from "@lib/plugins/tools";

/**
 * The built-in tools' registrar (spec §5). Both tools go in through the same
 * `registerTool` seam a plugin uses, owned by the built-in plugin's `Host`, so
 * the loop resolves them exactly as it would a plugin's tool.
 *
 * They register first (this runs at boot, before any plugin loads), which is
 * what makes a plugin's same-name tool a refused duplicate rather than a
 * silent replacement.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerToolBuiltins = (host: Host): void => {
	registerTool(host, fetchUrlBuiltin);
	registerTool(host, webSearchBuiltin);
};
