import { bareImports } from "@lib/build/bareImports";
import { PluginLoadFailed } from "@lib/plugins/errors";
import { setHostGlobals } from "@lib/plugins/globals";
import type { Host } from "@lib/plugins/host";
import type { ModuleImporter, PluginModule } from "@lib/plugins/loader";
import { Effect } from "effect";

/**
 * Loading a plugin's entry as a module (spec §6).
 *
 * A plugin is one pre-built ES module **with no imports**: a bundled app has no
 * module resolver for a plugin directory, and a module created from a `Blob`
 * URL cannot resolve a bare specifier at all (the browser answers "Failed to
 * resolve module specifier", which names neither the plugin nor the rule). So
 * the host supplies React and the API through globals set immediately before
 * the import, and a plugin that still imports a bare specifier is refused here
 * with a message that names the contract instead of the browser's.
 *
 * Production imports the source text as a `blob:` module. Dev imports the
 * pre-built entry URL directly (`web/public/plugins/<id>/main.js`, served by
 * Vite as a static asset): the contract is the same in both, and a URL import
 * gives the dev server's itself-named module for free. The choice is
 * `import.meta.env.DEV`, which Vite replaces at build time.
 */

const viteEnv = import.meta.env as
	| { readonly DEV?: boolean; readonly BASE_URL?: string }
	| undefined;

/** Dev means "the app is being served by Vite", never "tests are running". */
const isDev = viteEnv?.DEV === true;
const baseUrl = viteEnv?.BASE_URL ?? "/";

/**
 * The first bare specifier the source imports, or `null` when it imports none.
 * Delegates to the **same** `bareImports` the build-time chunk guard runs, so
 * the rule has one encoding rather than two that can drift: the two seams ask
 * different questions — "does this built chunk import anything bare?" (all of
 * them, to fail the build) versus "which specifier should the refusal name?"
 * (the first) — but must never disagree about what counts as bare.
 */
const firstBareSpecifier = (source: string): string | null =>
	bareImports(source)[0] ?? null;

/**
 * The user-facing copy for a plugin that broke the no-imports contract. It
 * names the plugin, the offending specifier and the fix, because the browser's
 * own message ("Failed to resolve module specifier") says none of that.
 */
const contractMessage = (
	pluginId: string,
	name: string,
	specifier: string,
): string =>
	`plugin "${pluginId}" imports "${specifier}" from ${name}: a plugin is one ` +
	"pre-built ES module with no imports — the host exposes React and the API " +
	"through globals (spec §6). Rebuild it with scripts/build-plugins.ts, which " +
	"rewrites react and the jsx runtime onto those globals.";

/** The failure detail for an import that rejected — a syntax error or worse. */
const describeImportError = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * Import a module from a URL, mapping any rejection to a `PluginLoadFailed`.
 * `Effect.tryPromise` rather than `await` — `import()` is a promise, and the
 * subsystem's whole surface is Effect.
 */
const importModuleUrl = (
	url: string,
	pluginId: string,
	label: string,
): Effect.Effect<unknown, PluginLoadFailed> =>
	Effect.tryPromise({
		try: () => import(/* @vite-ignore */ url) as Promise<unknown>,
		catch: (cause) =>
			new PluginLoadFailed({
				detail: `plugin "${pluginId}" failed to import ${label}: ${describeImportError(cause)}`,
				pluginId,
			}),
	});

/** The module's default export must be `{ setup }` (spec §2), or it is refused. */
const asPluginModule = (
	imported: unknown,
	pluginId: string,
): Effect.Effect<PluginModule, PluginLoadFailed> => {
	const candidate = (imported as { readonly default?: unknown } | null)
		?.default;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof (candidate as { readonly setup?: unknown }).setup !== "function"
	) {
		return Effect.fail(
			new PluginLoadFailed({
				detail: `plugin "${pluginId}" has no default export with a setup function (spec §2)`,
				pluginId,
			}),
		);
	}
	return Effect.succeed(candidate as PluginModule);
};

/**
 * Import a module from an arbitrary URL (spec §6) — the mechanism behind
 * {@link moduleImporter}, exported so a dev or proof caller can import a
 * built entry URL directly. Sets no globals of its own; the caller owns that
 * ordering.
 */
export const importModule = (
	url: string,
	pluginId = "plugin",
): Effect.Effect<PluginModule, PluginLoadFailed> =>
	importFrom(url, pluginId, url);

/** Import from a URL and validate the module shape, labelling failures with `label`. */
const importFrom = (
	url: string,
	pluginId: string,
	label: string,
): Effect.Effect<PluginModule, PluginLoadFailed> =>
	importModuleUrl(url, pluginId, label).pipe(
		Effect.flatMap((imported) => asPluginModule(imported, pluginId)),
	);

/**
 * The loader-facing importer (spec §6), bound to one plugin's `Host` and id.
 * It refuses a source that breaks the no-imports contract, sets the host
 * globals, then imports the entry — as a blob in production, or from the
 * built static asset URL in dev. Bound per load because the globals it sets
 * are that plugin's `Host`.
 */
export const moduleImporter = (
	host: Host,
	pluginId: string,
): ModuleImporter => ({
	importSource: (source, name) =>
		Effect.gen(function* () {
			const specifier = firstBareSpecifier(source);
			if (specifier !== null) {
				return yield* new PluginLoadFailed({
					detail: contractMessage(pluginId, name, specifier),
					pluginId,
				});
			}

			setHostGlobals(host);

			if (isDev) {
				return yield* importFrom(
					`${baseUrl}plugins/${pluginId}/${name}`,
					pluginId,
					name,
				);
			}

			const url = yield* Effect.sync(() =>
				URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
			);
			return yield* importFrom(url, pluginId, name).pipe(
				Effect.onExit(() => Effect.sync(() => URL.revokeObjectURL(url))),
			);
		}),
});
