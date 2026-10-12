import type { Host } from "@lib/plugins/host";

/**
 * The built-in provider protocols' registrar (spec §5). **Empty until Task 11
 * fills it** — a seam, not dead code: `builtin/index.ts` already calls it, so
 * Task 11 registers the three shipping protocols without editing the shared hub.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerProviderBuiltins = (_host: Host): void => {};
