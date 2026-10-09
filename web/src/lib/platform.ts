/**
 * True when the app runs inside the Tauri desktop shell. Tauri injects
 * `__TAURI_INTERNALS__` before the frontend script runs, so a module-level read
 * is safe and correct for the whole session.
 */
export const isDesktop: boolean = "__TAURI_INTERNALS__" in globalThis;
