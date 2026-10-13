/**
 * The generator's entry list: which shipped modules are the plugin API, and
 * how each is labelled. The list is the one piece of curation in the reference;
 * everything else — every export, the slot map, the manifest fields, the event
 * names — is read out of the source.
 *
 * A module that does not exist yet is not an error. Several land while the
 * plugin system is being built (the Phase 2 seams), and the docs build must
 * never break the app's deploy because a module is not written. A missing
 * module is emitted as `pending` and named on the page, so the reference is
 * honest about its coverage instead of silently short.
 */

/** One module in the surface. Paths are relative to `web/`. */
export interface SurfaceModule {
	readonly path: string;
	readonly label: string;
	readonly summary: string;
}

/**
 * Task 17's SDK re-exports the API types. Once it exists it *is* the surface a
 * plugin is compiled against, so it replaces the per-module list rather than
 * sitting beside it — the reference then mirrors what an author imports.
 */
export const sdkModule: SurfaceModule = {
	path: "src/lib/plugins/sdk.ts",
	label: "Plugin SDK",
	summary:
		"The single module a plugin imports: the API types and the schema-derived types, re-exported.",
};

/** The per-module surface, used until `sdk.ts` exists. */
export const surfaceModules: readonly SurfaceModule[] = [
	{
		path: "src/lib/plugins/host.ts",
		label: "Host API",
		summary:
			"The `Host` object a plugin's `setup` receives — the app and API versions, and one registry per kind.",
	},
	{
		path: "src/lib/plugins/manifest.ts",
		label: "Manifest",
		summary:
			"`plugin.json` and the per-plugin persisted state, both decoded with zod.",
	},
	{
		path: "src/lib/plugins/ids.ts",
		label: "Identifiers",
		summary:
			"The slot, capability and event unions — the slot map's source of truth.",
	},
	{
		path: "src/lib/plugins/tools.ts",
		label: "Tools",
		summary:
			"Model-callable tools: the declaration sent on the wire, the registry lookup and execution.",
	},
	{
		path: "src/lib/plugins/providers.ts",
		label: "Providers",
		summary: "The wire protocols the chat loop can send a turn through.",
	},
	{
		path: "src/lib/plugins/pipeline.ts",
		label: "Pipeline",
		summary:
			"Ordered middleware stages around a request and its streamed reply.",
	},
	{
		path: "src/lib/plugins/commands.ts",
		label: "Commands",
		summary: "Commands and keybindings for the command palette.",
	},
	{
		path: "src/lib/plugins/themes.ts",
		label: "Themes",
		summary:
			"Theme variables and one optional stylesheet, applied to the document root.",
	},
	{
		path: "src/lib/plugins/notify.ts",
		label: "Notifications",
		summary:
			"Toasts, banners, confirms and modals, rendered by host components so they match the app.",
	},
	{
		path: "src/lib/plugins/renderers.ts",
		label: "Renderers",
		summary:
			"Replacements for the message, markdown, marker and reasoning renderers.",
	},
	{
		path: "src/lib/plugins/settings.ts",
		label: "Settings sections",
		summary: "Plugin-contributed sections on the Settings page.",
	},
	{
		path: "src/lib/plugins/services.ts",
		label: "Host services",
		summary:
			"Chat, scoped storage, the event bus, logging and the native bridge (a stub on web) — the behaviour a plugin calls.",
	},
];

/** The author guide Task 19 adds; linked once it exists. */
export const authorGuidePath = "web/plugins/README.md";

/** The modules the reference should cover right now, in order. */
export const referenceEntries = (
	exists: (path: string) => boolean,
): readonly SurfaceModule[] =>
	exists(sdkModule.path) ? [sdkModule] : surfaceModules;

/** Entry-list modules with no source on disk yet, in declaration order. */
export const pendingModules = (
	exists: (path: string) => boolean,
): readonly SurfaceModule[] =>
	surfaceModules.filter((module) => !exists(module.path));
