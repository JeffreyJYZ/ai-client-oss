import type { Host, ThemeDefinition } from "@lib/plugins/sdk";
import { Effect, Option } from "effect";
import { createElement, useState } from "react";

/**
 * theme-solarized — a theme plus its own Settings section (spec §4/§5).
 *
 * What it proves:
 *
 * - the **`themes` service** holds a plugin's contribution
 *   (`host.themes.register`), in the same collection the app's own dark theme
 *   lives in;
 * - the service **applies** it (`host.themes.apply`), through the app's one
 *   core: the same `<style>` element and the same `data-theme` marker the
 *   built-in's apply uses. The plugin no longer writes CSS variables onto the
 *   document root itself — that was the workaround for a missing seam and is
 *   gone;
 * - the **`settings` registry** renders a plugin section
 *   (`host.settings.registerSection`) that looks like a built-in one, because it
 *   is the same `settings.sections` slot;
 * - **persistence**: the on/off choice is stored with `host.storage`, which
 *   rides `Settings.plugins[].data` inside the app's own settings blob, so a
 *   page reload re-applies the theme with nothing clicked.
 */

/** The theme, in exactly the shape the `themes` service stores. */
const THEME: ThemeDefinition = {
	id: "example.solarized",
	name: "Solarized",
	variables: {
		"--app-bg": "#002b36",
		"--app-fg": "#93a1a1",
		"--app-heading": "#fdf6e3",
		"--app-link": "#268bd2",
		"--app-link-hover": "#2aa198",
		"--app-code-bg": "rgba(255, 255, 255, 0.06)",
	},
	css: "body { letter-spacing: 0.01em; }",
};

/** The key this plugin stores its choice under, inside its own `data`. */
const STORAGE_KEY = "applied";

export default {
	setup(host: Host) {
		/** The persisted choice, read synchronously out of the app's settings. */
		const readApplied = (): boolean => {
			const stored = Effect.runSync(host.storage.get(STORAGE_KEY));
			return Option.isSome(stored) && stored.value === true;
		};

		// The registry contribution. `THEME` is a variable, not a fresh object
		// literal, so its extra fields (`name`, `variables`, `css`) pass the
		// service's `ThemeDefinition` parameter type.
		host.themes.register(THEME);

		// The toggle's two directions, both through the app's one theme core.
		// `apply` and `clear` are Effects (see the guide's runner note); running
		// them here is the same idiom `host.storage` uses below.
		const setApplied = (on: boolean): void => {
			Effect.runSync(on ? host.themes.apply(THEME.id) : host.themes.clear());
			// `host.storage` is the app's own per-plugin store; the write rides
			// `Settings.plugins[].data`, so it needs no extra file and no
			// capability.
			Effect.runSync(host.storage.set(STORAGE_KEY, on));
			host.log.info(`solarized theme ${on ? "applied" : "cleared"}`);
		};

		// Persistence: a page reload runs `setup` again and re-applies at once.
		if (readApplied()) setApplied(true);

		host.settings.registerSection({
			id: "example.theme-solarized.section",
			title: "Solarized theme",
			order: 95,
			component: function SolarizedSection() {
				const [on, setOn] = useState(readApplied());
				return createElement(
					"label",
					{
						className:
							"flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500",
					},
					createElement("input", {
						type: "checkbox",
						checked: on,
						className: "h-4 w-4 accent-neutral-300",
						onChange: (event: { target: { checked: boolean } }) => {
							const next = event.target.checked;
							setOn(next);
							setApplied(next);
						},
					}),
					"Apply the Solarized colour variables",
				);
			},
		});

		host.log.info("theme-solarized loaded; section registered");

		return {
			// Unload restores the defaults if this plugin's theme is the active one
			// — never another theme's. The registration itself is collected by the
			// `Scope`, and the service's reconciliation fibre is the backstop for
			// the same case.
			dispose: () => {
				if (Option.contains(Effect.runSync(host.themes.active()), THEME.id)) {
					Effect.runSync(host.themes.clear());
				}
				host.log.info("theme-solarized unloaded; theme cleared");
			},
		};
	},
};
