import type { Host } from "@lib/plugins/host";

/**
 * The built-in commands' registrar (spec §5). **Empty until Task 13 fills it** —
 * a seam, not dead code: `builtin/index.ts` already calls it, so Task 13
 * registers the shipping commands (new chat, toggle settings, stop, copy last
 * reply, check for updates, export backup) without editing the shared hub.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerCommandBuiltins = (_host: Host): void => {};
