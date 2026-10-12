import { PluginFault } from "@lib/plugins/errors";
import type { Disposable, HostRegistry } from "@lib/plugins/host";
import type { RegistryEntry } from "@lib/plugins/registry";
import { Effect, Option, Stream } from "effect";

/**
 * The theme seam (spec §4/§5): a theme is variables plus one optional CSS
 * block, and the service applies them to the document root and owns a single
 * `<style>` element.
 *
 * **Honest limit, per spec §4.** The app's colours are Tailwind utility classes
 * (`bg-neutral-950`, `text-neutral-300`, `border-neutral-800`), not tokens. A
 * theme therefore restyles everything a CSS variable or a CSS rule reaches —
 * the page surface, the markdown body, anything a theme's own `css` selects —
 * and nothing that is a utility class on some other element. Full token-driven
 * theming needs a semantic-token refactor of every class string in the app,
 * which is deliberately out of scope; this seam does not pretend to be it.
 *
 * The built-in dark theme is a contribution (spec §12) so the mechanism is
 * exercised by the app itself, not only by a fixture.
 */

/**
 * The DOM the service reads and writes: the root element's custom properties,
 * the one stylesheet it owns, and the marker of the active theme. It is a seam
 * because bun's test environment has no DOM — the rules are asserted against a
 * recorded {@link ThemeDom}, while the real element path ({@link browserThemeDom})
 * is deliberately tiny and proven in a browser.
 */
export interface ThemeDom {
	readonly setVariable: (name: string, value: string) => void;
	readonly removeVariable: (name: string) => void;
	/** Replace the one stylesheet; `undefined` removes it (defaults restored). */
	readonly setStyleSheet: (css: string | undefined) => void;
	/** Record the active theme's id on the root, or clear it. */
	readonly setActiveId: (id: string | undefined) => void;
}

/** The id of the service's single stylesheet, so a switch finds and reuses it. */
const STYLE_ELEMENT_ID = "ai-client-theme";

/** Where the active theme's id is recorded, readable from devtools and tests. */
const ACTIVE_ATTRIBUTE = "data-theme";

/**
 * The real DOM adapter. One element, found by {@link STYLE_ELEMENT_ID} and
 * reused, so a switch replaces the stylesheet rather than appending a second;
 * `undefined` removes it, which is what restores the `:root` defaults.
 */
export const browserThemeDom = (): ThemeDom => {
	// Read lazily: constructing the adapter must not touch `document`, so the
	// registration path is exercised in an environment with no DOM (tests) and
	// only applying a theme needs the real document.
	const root = (): HTMLElement => document.documentElement;
	return {
		setVariable: (name, value) => root().style.setProperty(name, value),
		removeVariable: (name) => root().style.removeProperty(name),
		setStyleSheet: (css) => {
			const existing = document.getElementById(STYLE_ELEMENT_ID);
			if (css === undefined) {
				existing?.remove();
				return;
			}
			const element =
				existing instanceof HTMLStyleElement
					? existing
					: document.createElement("style");
			element.id = STYLE_ELEMENT_ID;
			element.textContent = css;
			if (!element.isConnected) document.head.append(element);
		},
		setActiveId: (id) => {
			if (id === undefined) root().removeAttribute(ACTIVE_ATTRIBUTE);
			else root().setAttribute(ACTIVE_ATTRIBUTE, id);
		},
	};
};

/**
 * One theme contribution, as stored in the `themes` registry. The registry's
 * own type is the untyped `RegistryEntry` (spec §2's uniform registry), so the
 * theme's data half rides the entry and the service narrows on read.
 */
export interface ThemeContribution extends RegistryEntry {
	readonly name: string;
	readonly variables: Readonly<Record<string, string>>;
	/** Extra rules the variables cannot express; replaced on switch. */
	readonly css?: string;
}

/** A theme as an author writes one: identity and data, no owner plumbing. */
export type ThemeDefinition = Omit<ThemeContribution, "owner">;

/** The theme registry a plugin drives (spec §5). */
export interface ThemeService {
	/** Register a theme; disposing the handle unregisters it. */
	readonly register: (theme: ThemeDefinition) => Disposable;
	/** Apply a registered theme by id. An unknown id leaves the defaults on. */
	readonly apply: (id: string) => Effect.Effect<void>;
	/** The active theme's id, or `Option.none()` when the defaults are in force. */
	readonly active: () => Effect.Effect<Option.Option<string>>;
	/** Reconcile with one registry snapshot: drop an active theme that is gone. */
	readonly sync: (entries: readonly RegistryEntry[]) => Effect.Effect<void>;
	/** Reconcile on every registry change; fork this for the plugin-unload path. */
	readonly run: () => Effect.Effect<void>;
}

/**
 * The entry, narrowed. A cast rather than a guard because the registry is
 * deliberately untyped (a plugin could not otherwise extend a contribution),
 * and a malformed theme is a plugin bug the pipeline reports, not a shape this
 * service can reject.
 */
const asTheme = (entry: RegistryEntry): ThemeContribution =>
	entry as ThemeContribution;

/**
 * The theme service over one registry (spec §3's `ThemeRegistry`). The applied
 * state is the DOM's — there is one `documentElement` — so the service keeps
 * only which theme it put there, and every method that touches it is an
 * `Effect.sync`.
 */
export const makeThemeService = (
	themes: HostRegistry<RegistryEntry>,
	dom: ThemeDom = browserThemeDom(),
): ThemeService => {
	let activeTheme: ThemeContribution | null = null;

	/** Undo one theme: its variables, the stylesheet, the active marker. */
	const clear = (theme: ThemeContribution): void => {
		for (const name of Object.keys(theme.variables)) dom.removeVariable(name);
		dom.setStyleSheet(undefined);
		dom.setActiveId(undefined);
	};

	/** Restore the `:root` defaults (the app's own values, per `App.css`). */
	const restoreDefaults = (): void => {
		if (activeTheme === null) return;
		clear(activeTheme);
		activeTheme = null;
	};

	const register: ThemeService["register"] = (theme) => {
		const inner = themes.register(theme);
		return {
			dispose: () => {
				inner.dispose();
				// Disposing is the explicit unregister: restore at once, so the
				// unloaded theme's variables cannot outlive it.
				if (activeTheme !== null && activeTheme.id === theme.id) {
					restoreDefaults();
				}
			},
		};
	};

	const apply: ThemeService["apply"] = (id) =>
		Effect.gen(function* () {
			const entries = yield* themes.entries();
			const entry = entries.find((candidate) => candidate.id === id);
			if (entry === undefined) {
				yield* Effect.logWarning(
					new PluginFault({
						detail: `no theme is registered with id "${id}"; the defaults remain applied`,
					}),
				);
				return;
			}
			const theme = asTheme(entry);
			yield* Effect.sync(() => {
				restoreDefaults();
				for (const [name, value] of Object.entries(theme.variables)) {
					dom.setVariable(name, value);
				}
				dom.setStyleSheet(theme.css);
				dom.setActiveId(theme.id);
				activeTheme = theme;
			});
		});

	const active: ThemeService["active"] = () =>
		Effect.sync(() =>
			activeTheme === null
				? Option.none<string>()
				: Option.some(activeTheme.id),
		);

	/**
	 * A plugin's scope closing removes its registrations through the registry's
	 * own finalizer, not through the handle above — so a theme that was active
	 * when its plugin unloaded would otherwise leave its variables applied. This
	 * snapshot check is the second, path-independent half of the restore.
	 */
	const sync: ThemeService["sync"] = (entries) =>
		Effect.sync(() => {
			const current = activeTheme;
			if (current === null) return;
			if (!entries.some((entry) => entry.id === current.id)) {
				restoreDefaults();
			}
		});

	const run: ThemeService["run"] = () =>
		Stream.runForEach(themes.changes, sync);

	return { register, apply, active, sync, run };
};

/**
 * The app's one theme service (spec §3), set by the theme built-in at boot
 * (`builtin/themes`). `applyTheme`/`activeTheme` are the free-function surface
 * a plugin is given; before the built-in registers there is no service, and
 * they degrade to "the defaults are in force" rather than failing.
 */
let appService: ThemeService | null = null;

export const setAppThemeService = (service: ThemeService): void => {
	appService = service;
};

/** Apply a theme by id (spec §5). */
export const applyTheme = (id: string): Effect.Effect<void> =>
	appService === null ? Effect.void : appService.apply(id);

/** The active theme's id, or `Option.none()` when the defaults are in force. */
export const activeTheme = (): Effect.Effect<Option.Option<string>> =>
	appService === null
		? Effect.succeed(Option.none<string>())
		: appService.active();
