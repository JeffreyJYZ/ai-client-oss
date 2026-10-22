import { isDesktop } from "@lib/platform";
import { invoke } from "@tauri-apps/api/core";

/** The shell command (see `web/src-tauri/src/lib.rs`). */
export const OPEN_EXTERNAL_COMMAND = "open_external";

/**
 * Open one http(s) URL in the user's default browser.
 *
 * A webview cannot do this by itself: Tauri v2 does not hand an external
 * `target="_blank"` navigation to the OS, so an in-app link to the docs site
 * does nothing on the desktop unless the shell opens it. The browser build
 * needs no bridge at all — it is already in a browser.
 *
 * Fire-and-forget: a link the shell cannot open leaves the window as it was,
 * and there is nothing a user could do with the reason.
 */
export const openExternal = (
	url: string,
	desktop: boolean = isDesktop,
): void => {
	if (!desktop) {
		window.open(url, "_blank", "noopener,noreferrer");
		return;
	}
	// A rejected invoke is the shell refusing or failing to launch the handler;
	// the page is unchanged either way, so the reason is dropped rather than
	// rendered (the same treatment the shell gives a failed abort).
	invoke(OPEN_EXTERNAL_COMMAND, { url }).catch(() => undefined);
};
