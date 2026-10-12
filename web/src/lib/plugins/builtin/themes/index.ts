import type { Host } from "@lib/plugins/host";

/**
 * The built-in themes' registrar (spec §4). **Empty until Task 14 fills it** —
 * a seam, not dead code: `builtin/index.ts` already calls it, so Task 14
 * registers the shipping dark theme (defined beside this file) without editing
 * the shared hub.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerThemeBuiltins = (_host: Host): void => {};
