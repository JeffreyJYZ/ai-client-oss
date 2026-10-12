/**
 * The Plugin SDK (spec §6): the single module a plugin imports. It re-exports
 * the **whole** documented surface — every module in `src/docs/entries.ts` —
 * because once this file exists the API reference is generated from it instead
 * of from the per-module list. An SDK that re-exported a subset would make the
 * published reference silently narrow to that subset, and a narrow page looks
 * exactly like a healthy one. `/docs` plus `src/docs/reference.test.ts` gate it.
 *
 * A plugin imports only types and the `setup` signature from here; the values
 * a plugin actually calls at runtime arrive on `host`, and React arrives
 * through the host globals (spec §6).
 */

export * from "./commands";
export * from "./host";
export * from "./ids";
export * from "./manifest";
export * from "./notify";
export * from "./pipeline";
export * from "./providers";
export * from "./renderers";
export * from "./settings";
export * from "./themes";
export * from "./tools";
