/**
 * Builds a plugin's source into the one static asset the loader imports
 * (spec §6). A plugin lives in `web/plugins/<id>/` (its `plugin.json` plus
 * `main.tsx` or `main.ts`) and builds to `web/public/plugins/<id>/main.js`,
 * which Vite serves as a static asset in dev and a deploy ships as-is in
 * production. The output directory is gitignored: a build product.
 *
 * The contract this preset serves is **one pre-built ES module with no
 * imports**. The host supplies React and the API through globals
 * (`web/src/lib/plugins/globals.ts`), so the preset resolves `react` and
 * `react/jsx-runtime` to virtual modules reading those globals
 * (`pluginGlobals.ts`) — **not** `external` + `output.globals`, which Rollup
 * applies to `iife`/`umd` only and which therefore leaves `format: "es"` output
 * with real `import "react"` statements the loader would refuse. JSX uses the
 * automatic runtime (`jsx: "react-jsx"`), so it compiles onto that jsx-runtime
 * module too. Every other bare specifier is bundled normally; one that cannot
 * be resolved fails the build, and the emitted chunk is re-checked for imports
 * so a preset regression fails here rather than when a user loads the plugin.
 *
 * Run from the repository root: `bun scripts/build-plugins.ts [<id>...]`.
 * With no ids, every `web/plugins/<id>/main.tsx|main.ts` is built.
 *
 * This is a build of a *plugin*, never of the app: `configFile: false` keeps
 * the app's Vite config (its React/Tailwind plugins, its two HTML entries, its
 * `dist/`) entirely out of the way.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bareImports } from "../web/src/lib/build/bareImports";
import { hostGlobalNames } from "../web/src/lib/plugins/globals";
import { hostGlobalModules, reactExportNames } from "./pluginGlobals";

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const pluginsRoot = join(webRoot, "plugins");
const outRoot = join(webRoot, "public", "plugins");

// Vite and react are dependencies of `web/`, not of the repo root, so resolve
// them through web's own package rather than relying on the working directory.
const requireFromWeb = createRequire(join(webRoot, "package.json"));
const { build } = (await import(requireFromWeb.resolve("vite"))) as {
	readonly build: (config: unknown) => Promise<unknown>;
};

/** The plugin entry file, `.tsx` first (JSX is the common case). */
const entryOf = (root: string): string | null => {
	for (const name of ["main.tsx", "main.ts"]) {
		const candidate = join(root, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
};

/** The plugin ids to build: the arguments, or every dir with an entry. */
const targets = (): readonly string[] => {
	const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
	if (ids.length > 0) return ids;
	if (!existsSync(pluginsRoot)) return [];
	return readdirSync(pluginsRoot).filter(
		(entry) => entryOf(join(pluginsRoot, entry)) !== null,
	);
};

const buildPlugin = async (id: string): Promise<void> => {
	const root = join(pluginsRoot, id);
	const entry = entryOf(root);
	if (entry === null) {
		throw new Error(`build-plugins: no main.tsx/main.ts in ${root}`);
	}
	const outDir = join(outRoot, id);
	await build({
		configFile: false,
		root,
		publicDir: false,
		logLevel: "warn",
		// JSX onto `react/jsx-runtime`, which the plugin below backs by globals.
		esbuild: { jsx: "automatic", jsxImportSource: "react" },
		plugins: [
			hostGlobalModules({
				react: hostGlobalNames.react,
				jsxRuntime: hostGlobalNames.jsxRuntime,
				reactExports: reactExportNames(
					requireFromWeb("react") as Record<string, unknown>,
				),
			}),
		],
		build: {
			lib: { entry, formats: ["es"], fileName: () => "main.js" },
			outDir,
			emptyOutDir: true,
			minify: false,
			sourcemap: false,
			target: "esnext",
			// The virtual React module reads many properties off the host global;
			// with property-read side effects assumed, every unused export would
			// survive as a bare `host.useRef;` statement. They are plain reads, so
			// let the tree-shaker drop the ones no plugin code uses.
			rollupOptions: { treeshake: { propertyReadSideEffects: false } },
		},
	});

	// Enforce the no-imports contract where it is introduced: a chunk that still
	// imports a bare specifier would be refused at load time, so fail the build.
	const output = join(outDir, "main.js");
	if (!existsSync(output)) {
		throw new Error(`build-plugins: ${id} produced no ${output}`);
	}
	const offenders = bareImports(readFileSync(output, "utf8"));
	if (offenders.length > 0) {
		throw new Error(
			`build-plugins: ${id} emitted bare import(s) ${offenders.map((s) => `"${s}"`).join(", ")} — ` +
				"a plugin must be one ESM file with no imports (spec §6)",
		);
	}

	process.stdout.write(
		`plugins: built ${id} → web/public/plugins/${id}/main.js (no imports)\n`,
	);
};

const ids = targets();
if (ids.length === 0) {
	process.stdout.write("plugins: nothing to build (no web/plugins/*/main.tsx)\n");
} else {
	for (const id of ids) {
		await buildPlugin(id);
	}
}
