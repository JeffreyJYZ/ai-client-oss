import type { Host } from "@lib/plugins/host";

/**
 * The overlay region's registrar (spec §4). **Empty until Task 15 fills it** —
 * a seam, not dead code: `builtin/index.ts` already calls it, so Task 15 mounts
 * the toast/modal components into `overlay.root` without editing the shared hub.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerOverlayBuiltins = (_host: Host): void => {};
