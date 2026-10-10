/**
 * True when the app runs inside the Tauri desktop shell. Tauri injects
 * `__TAURI_INTERNALS__` before the frontend script runs, so a module-level read
 * is safe and correct for the whole session.
 */
export const isDesktop: boolean = "__TAURI_INTERNALS__" in globalThis;

/**
 * True for a macOS browser. iPadOS reports "Macintosh" in its user agent, so
 * iOS/iPadOS is excluded explicitly. Used for the macOS-only install note for
 * the unsigned desktop build (the shell never needs it).
 */
export const isMacOS: boolean =
	/Macintosh|Mac OS X/.test(navigator.userAgent) &&
	!/iPhone|iPad|iPod/.test(navigator.userAgent);
