import { darkTheme } from "@lib/plugins/builtin/themes/dark";
import type { Host } from "@lib/plugins/host";
import { makeThemeService, setAppThemeService } from "@lib/plugins/themes";
import { Effect } from "effect";

/**
 * The built-in themes' registrar (spec §4/§12). The shipping dark theme is a
 * contribution, registered through the same `themes` registry a plugin uses, so
 * the app proves the seam instead of leaving it theoretical.
 *
 * Two things this has to own: the app's one service (the free-function
 * `applyTheme`/`activeTheme` surface reads it), and the reconciliation fiber —
 * a plugin's scope closing removes its theme through the registry's finalizer,
 * and if that theme was active the service must put the defaults back. The
 * fiber lives for the runtime's lifetime on `Effect.runFork`, which is the same
 * kind of long-lived fork `bridge.ts` starts for the UI registry.
 */
export const registerThemeBuiltins = (host: Host): void => {
	const themes = makeThemeService(host.themes);
	setAppThemeService(themes);
	themes.register(darkTheme);
	Effect.runFork(themes.run());
};
