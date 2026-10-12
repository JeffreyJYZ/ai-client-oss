/**
 * Builds a plugin's source into the one static asset the loader imports
 * (spec §6). A plugin lives in `web/plugins/<id>/` (its `plugin.json` plus
 * `main.ts`) and builds to `web/public/plugins/<id>/main.js`, which Vite serves
 * as a static asset in dev and a deploy ships as-is in production. The output
 * directory is gitignored: it is a build product, rebuilt by this script.
 *
 * The contract this preset serves is **one pre-built ES module with no
 * imports**: the host supplies React and the API through globals
 * (`web/src/lib/plugins/globals.ts`), so `react` and `react/jsx-runtime` are
 * external and mapped to those globals. The global names are imported from
 * `globals.ts` — never retyped here — so the preset and the setter cannot drift.
 *
 * Run from the repository root: `bun scripts/build-plugins.ts [<id>...]`.
 * With no ids, every `web/plugins/<id>/main.ts` is built.
 *
 * This is a build of a *plugin*, never of the app: `configFile: false` keeps
 * the app's Vite config (its React/Tailwind plugins, its two HTML entries, its
 * `dist/`) entirely out of the way.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostGlobalNames } from "../web/src/lib/plugins/globals";

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const pluginsRoot = join(webRoot, "plugins");
const outRoot = join(webRoot, "public", "plugins");

// Vite is a dependency of `web/`, not of the repo root, so resolve it through
// web's own package rather than relying on the working directory.
const requireFromWeb = createRequire(join(webRoot, "package.json"));
const { build } = (await import(requireFromWeb.resolve("vite"))) as {
	readonly build: (config: unknown) => Promise<unknown>;
};

/** The plugin ids to build: the arguments, or every dir with a `main.ts`. */
const targets = (): readonly string[] => {
	const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
	if (ids.length > 0) return ids;
	if (!existsSync(pluginsRoot)) return [];
	return readdirSync(pluginsRoot).filter((entry) =>
		existsSync(join(pluginsRoot, entry, "main.ts")),
	);
};

const buildPlugin = async (id: string): Promise<void> => {
	const root = join(pluginsRoot, id);
	const entry = join(root, "main.ts");
	if (!existsSync(entry)) {
		throw new Error(`build-plugins: no main.ts in ${root}`);
	}
	await build({
		configFile: false,
		root,
		publicDir: false,
		logLevel: "warn",
		build: {
			lib: { entry, formats: ["es"], fileName: () => "main.js" },
			outDir: join(outRoot, id),
			emptyOutDir: true,
			minify: false,
			sourcemap: false,
			target: "esnext",
			rollupOptions: {
				external: ["react", "react/jsx-runtime"],
				output: {
					globals: {
						react: hostGlobalNames.react,
						"react/jsx-runtime": hostGlobalNames.jsxRuntime,
					},
				},
			},
		},
	});
	process.stdout.write(
		`plugins: built ${id} → web/public/plugins/${id}/main.js\n`,
	);
};

const ids = targets();
if (ids.length === 0) {
	process.stdout.write("plugins: nothing to build (no web/plugins/*/main.ts)\n");
} else {
	for (const id of ids) {
		await buildPlugin(id);
	}
}
