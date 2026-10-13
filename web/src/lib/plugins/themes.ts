import { PluginFault } from "@lib/plugins/errors";
import type { Disposable, HostRegistry } from "@lib/plugins/host";
import type { Registry, RegistryEntry } from "@lib/plugins/registry";
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

/** The theme service a plugin drives (spec §5). */
export interface ThemeService {
	/** Register a theme; disposing the handle unregisters it. */
	readonly register: (theme: ThemeDefinition) => Disposable;
	/** Apply a registered theme by id. An unknown id leaves the defaults on. */
	readonly apply: (id: string) => Effect.Effect<void>;
	/**
	 * Restore the `:root` defaults: remove the active theme's variables, its
	 * stylesheet and its marker. The inverse of {@link apply}, and what a
	 * toggling plugin calls to switch a theme back off.
	 */
	readonly clear: () => Effect.Effect<void>;
	/** The active theme's id, or `Option.none()` when the defaults are in force. */
	readonly active: () => Effect.Effect<Option.Option<string>>;
	/** Reconcile with one registry snapshot: drop an active theme that is gone. */
	readonly sync: (entries: readonly RegistryEntry[]) => Effect.Effect<void>;
	/** Reconcile on every registry change; fork this for the plugin-unload path. */
	readonly run: () => Effect.Effect<void>;
}

/**
 * The app's one theme service, before it is bound to a plugin (spec §3). The
 * applied state is the DOM's — there is one `documentElement` and one
 * `<style>` element — so this holds only which theme is in force, and
 * {@link ThemeServiceCore.forPlugin} hands that shared state to each caller
 * with `register` bound to the caller's own registry view. Two plugins, or a
 * plugin and the built-in, therefore cannot end up with two stylesheets or two
 * `data-theme` markers: there is exactly one core per host services instance.
 */
interface ThemeServiceCore {
	/** The service as one plugin uses it: `register` owned by that plugin. */
	readonly forPlugin: (themes: HostRegistry<RegistryEntry>) => ThemeService;
	/** Reconcile on every change of the underlying registry; fork once. */
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
 * The app's one theme core over its `themes` registry (spec §3). `dom` is the
 * seam the writes go to — the real element path ({@link browserThemeDom}) in
 * the app, a recorded object in tests.
 *
 * **One instance, many facades.** The active theme, the `<style>` element and
 * the `data-theme` marker are the core's, created once by `HostLayer`; every
 * caller gets a {@link ThemeServiceCore.forPlugin} facade over that same core,
 * so `host.themes.apply` for a plugin is the built-in's apply, and no second
 * service with its own stylesheet can exist. `register` is the one member that
 * differs per caller: it is bound to the caller's registry view, so a theme is
 * owned by the plugin that registered it and is collected when its scope
 * closes.
 */
export const makeThemeService = (
	registry: Registry<RegistryEntry>,
	dom: ThemeDom = browserThemeDom(),
): ThemeServiceCore => {
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

	const apply: ThemeService["apply"] = (id) =>
		Effect.gen(function* () {
			const entries = yield* registry.entries();
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

	/** The toggle-off half: restore the defaults through the same DOM. */
	const clearActive: ThemeService["clear"] = () =>
		Effect.sync(() => {
			restoreDefaults();
		});

	const active: ThemeService["active"] = () =>
		Effect.sync(() =>
			activeTheme === null
				? Option.none<string>()
				: Option.some(activeTheme.id),
		);

	/**
	 * A plugin's scope closing removes its registrations through the registry's
	 * own finalizer — so a theme that was active when its plugin unloaded would
	 * otherwise leave its variables applied. This snapshot check is the second,
	 * path-independent half of the restore, and it is why the core's shared
	 * `run` is forked once.
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
		Stream.runForEach(registry.changes, sync);

	const forPlugin = (themes: HostRegistry<RegistryEntry>): ThemeService => ({
		register: (theme) => {
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
		},
		apply,
		clear: clearActive,
		active,
		sync,
		run,
	});

	return { forPlugin, run };
};

/**
 * The app-internal handle on the one theme core (spec §3), set by the theme
 * built-in at boot (`builtin/themes`). It exists for app code that applies a
 * theme without a plugin in hand; a plugin does not use it — a plugin reaches
 * the same core through `host.themes` (the typed {@link ThemeService}), which
 * is why `applyTheme`/`activeTheme` are no longer the only way in. Before the
 * built-in registers there is no handle, and they degrade to "the defaults are
 * in force" rather than failing.
 */
let appService: ThemeService | null = null;

export const setAppThemeService = (service: ThemeService): void => {
	appService = service;
};

/** Apply a theme by id (spec §5), through the one core. */
export const applyTheme = (id: string): Effect.Effect<void> =>
	appService === null ? Effect.void : appService.apply(id);

/** The active theme's id, or `Option.none()` when the defaults are in force. */
export const activeTheme = (): Effect.Effect<Option.Option<string>> =>
	appService === null
		? Effect.succeed(Option.none<string>())
		: appService.active();
