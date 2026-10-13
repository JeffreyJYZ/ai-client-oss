import { darkTheme } from "@lib/plugins/builtin/themes/dark";
import type { Host } from "@lib/plugins/host";
import { setAppThemeService } from "@lib/plugins/themes";
import { Effect } from "effect";

/**
 * The built-in themes' registrar (spec §4/§12). The shipping dark theme is a
 * contribution, registered through the same `theme` service a plugin uses, so
 * the app proves the seam instead of leaving it theoretical.
 *
 * **This no longer builds the service.** The app's one theme core is created in
 * `HostLayer` (the host-services factory) before any built-in or plugin runs,
 * so there is exactly one `<style>` element and one `data-theme` marker from
 * boot — `host.themes` here is a facade over that core, and so is every
 * plugin's. What is left to do at boot is point the app-internal
 * `applyTheme`/`activeTheme` handle at the core, register the dark theme, and
 * fork the reconciliation fibre: a plugin's scope closing removes its theme
 * through the registry's finalizer, and if that theme was active the service
 * must put the defaults back. The fibre lives for the runtime's lifetime on
 * `Effect.runFork`, the same kind of long-lived fork `bridge.ts` starts for the
 * UI registry.
 */
export const registerThemeBuiltins = (host: Host): void => {
	setAppThemeService(host.themes);
	host.themes.register(darkTheme);
	Effect.runFork(host.themes.run());
};
