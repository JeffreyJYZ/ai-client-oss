import type { Host, ThemeDefinition } from "@lib/plugins/sdk";
import { Effect, Option } from "effect";
import { createElement, useState } from "react";

/**
 * theme-solarized — a theme plus its own Settings section (spec §4/§5).
 *
 * What it proves:
 *
 * - the **`themes` registry** holds a contribution a plugin registered
 *   (`host.themes.register`), in the same collection the app's own dark theme
 *   lives in;
 * - the **`settings` registry** renders a plugin section
 *   (`host.settings.registerSection`) that looks like a built-in one, because it
 *   is the same `settings.sections` slot;
 * - **persistence**: the on/off choice is stored with `host.storage`, which
 *   rides `Settings.plugins[].data` inside the app's own settings blob, so a
 *   page reload re-applies the theme with nothing clicked.
 *
 * ---------------------------------------------------------------------------
 * The gap this example hits, and why the code below looks the way it does.
 *
 * `host.themes` is typed `HostRegistry<RegistryEntry>`: a plugin can put a
 * theme **into** the registry, but there is no `host.themes.apply(id)`. The
 * service that applies one (`makeThemeService(...).apply`) and the free
 * functions over the app's service (`applyTheme`, `activeTheme`) are exports of
 * a *host module* — and a plugin may not import a host module (the module
 * contract), nor are they members of `host`. The built-in dark theme works only
 * because `builtin/themes/index.ts` is app code: it builds the service and
 * forks it.
 *
 * So this example does what the theme service would do — write the variables
 * onto the document root and own one `<style>` element — and says so. It is a
 * workaround for a missing seam, not the intended route: the theme service's
 * own `data-theme` marker and stylesheet ownership are therefore NOT exercised
 * here.
 * ---------------------------------------------------------------------------
 */

/** The theme, in exactly the shape the `themes` registry stores. */
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

/** The id of the `<style>` element this plugin owns (the service's own idiom). */
const STYLE_ID = "example-solarized-style";

export default {
	setup(host: Host) {
		/** The persisted choice, read synchronously out of the app's settings. */
		const readApplied = (): boolean => {
			const stored = Effect.runSync(host.storage.get(STORAGE_KEY));
			return Option.isSome(stored) && stored.value === true;
		};

		const apply = (): void => {
			for (const [name, value] of Object.entries(THEME.variables)) {
				document.documentElement.style.setProperty(name, value);
			}
			if (THEME.css !== undefined) {
				// The service owns one element by a fixed id; so does this plugin.
				const existing = document.getElementById(STYLE_ID);
				const element =
					existing instanceof HTMLStyleElement
						? existing
						: document.createElement("style");
				element.id = STYLE_ID;
				element.textContent = THEME.css;
				if (!element.isConnected) document.head.append(element);
			}
			document.documentElement.setAttribute("data-theme", THEME.id);
			host.log.info(
				`solarized applied (${Object.keys(THEME.variables).length} variables)`,
			);
		};

		const clear = (): void => {
			for (const name of Object.keys(THEME.variables)) {
				document.documentElement.style.removeProperty(name);
			}
			document.getElementById(STYLE_ID)?.remove();
			document.documentElement.removeAttribute("data-theme");
		};

		// The registry contribution. `THEME` is a variable, not a fresh object
		// literal, so its extra fields (`name`, `variables`, `css`) pass the
		// generic registry's narrower parameter type — the runtime is untyped at
		// this boundary either way.
		host.themes.register(THEME);

		// Proof the entry really landed in the app's one `themes` registry: the
		// built-in dark theme is in the same list, which only the shared registry
		// could contain. (A registry `entries()` read is an Effect; running it here
		// is the runner note in the author's guide.)
		const ids = Effect.runSync(host.themes.entries()).map((entry) => entry.id);
		host.log.info(`themes registry now holds ${JSON.stringify(ids)}`);

		// Persistence: a page reload runs `setup` again and re-applies at once.
		if (readApplied()) apply();

		const setApplied = (on: boolean): void => {
			if (on) apply();
			else clear();
			// `host.storage` is the app's own per-plugin store; the write rides
			// `Settings.plugins[].data`, so it needs no extra file and no
			// capability. It returns an Effect; see the guide's runner note.
			Effect.runSync(host.storage.set(STORAGE_KEY, on));
			host.log.info(`solarized theme ${on ? "applied" : "cleared"}`);
		};

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
			// Unload clears the theme: a disabled plugin must leave no trace
			// (spec §3). The registration itself is collected by the Scope.
			dispose: () => {
				clear();
				host.log.info("theme-solarized unloaded; theme cleared");
			},
		};
	},
};
