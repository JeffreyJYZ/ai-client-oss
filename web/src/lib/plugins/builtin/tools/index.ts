import type { Host } from "@lib/plugins/host";

/**
 * The built-in tools' registrar (spec §5). **Empty until Task 10 fills it** —
 * a seam, not dead code: `builtin/index.ts` already calls it, so Task 10 adds
 * tools without editing the shared hub, and the tree keeps compiling either way.
 *
 * The two built-in tools (`fetch_url`, `web_search`) live beside this file.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerToolBuiltins = (_host: Host): void => {};
