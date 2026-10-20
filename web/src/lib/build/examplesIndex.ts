/**
 * The example index the app ships beside the built plugin chunks.
 *
 * `scripts/build-plugins.ts` writes `web/public/plugins/examples.json` from
 * this module's output, and the Plugins section renders it — so a release
 * carries working examples instead of pointing at a repository the user has to
 * clone and build. It is **pure** (no fs, no network) so the shape is testable
 * in `web/`, which is the only place this repo gates behaviour.
 *
 * What it deliberately does not carry: the plugin's source. That is a separate
 * asset (`/plugins/<id>/main.js`) fetched only when the user installs one, so
 * the index stays small enough to ship in the Settings render path.
 */

/** One installable example, as the index and the Settings list need it. */
export interface PluginExample {
	/** The directory name under `web/plugins/` — the chunk path, not the manifest `id` (which the manifest text carries). */
	readonly id: string;
	/**
	 * The manifest's own `id`, read from the manifest at build time. This is the
	 * id an install writes (the loader stores a plugin under its manifest id), so
	 * it is the key an "already installed" check must compare against — the
	 * directory name above is a build path and would never match.
	 */
	readonly pluginId: string;
	/** The manifest `name`, for the row. */
	readonly name: string;
	/** The manifest `description`, already one sentence. */
	readonly description: string;
	/** Where the built chunk is served from, absolute on the app's origin. */
	readonly entry: string;
	/** The manifest file's own text — install takes files, keyed by name. */
	readonly manifest: string;
}

/** The file `public/plugins/examples.json` holds. `version` allows a later shape. */
export interface ExamplesIndex {
	readonly version: 1;
	readonly examples: readonly PluginExample[];
}

/** The served path of one example's built chunk. */
export const exampleEntry = (id: string): string => `/plugins/${id}/main.js`;

/**
 * Build the index. Sorted by id so the file is stable across machines (a
 * directory read order that leaked into the artifact would make every build a
 * diff), and the entry path is derived here rather than passed in, so it cannot
 * disagree with {@link exampleEntry}.
 */
export const examplesIndex = (
	rows: readonly Omit<PluginExample, "entry">[],
): ExamplesIndex => ({
	version: 1,
	examples: [...rows]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((row) => ({ ...row, entry: exampleEntry(row.id) })),
});

/**
 * Whether an example is already installed, so its row says so instead of
 * offering a second install. The installed set is the plugin store's ids, which
 * are the manifests' own ids — compare against {@link PluginExample.pluginId},
 * never the directory name. An empty id (an index written before it carried
 * one) is treated as unknown, so the row keeps its Install button rather than
 * claiming an install it cannot verify.
 */
export const exampleInstalled = (
	example: PluginExample,
	installedIds: ReadonlySet<string>,
): boolean => example.pluginId !== "" && installedIds.has(example.pluginId);
