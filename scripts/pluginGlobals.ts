import type { Plugin } from "vite";

/**
 * The preset's host-globals modules (spec §6).
 *
 * A plugin's entry must end up as **one ESM file with no imports**, because the
 * loader imports it from a `blob:` URL, which cannot resolve a bare specifier,
 * and because the host is what supplies React and the API. `output.globals`
 * cannot deliver that for `format: "es"` — it is a Rollup option for `iife`/`umd`
 * only — so this preset instead **resolves** `react` and `react/jsx-runtime` to
 * virtual modules whose bindings are read off `globalThis` where
 * `setHostGlobals` put them. The bundle then has nothing to import: React is
 * inlined as references to the host's own instance, which is also what keeps a
 * plugin's hooks on the app's React rather than a second copy.
 *
 * `react`'s export names are generated from the **installed** package
 * (`reactExportNames`) rather than hand-listed, so a React that gains a hook
 * does not silently leave plugins unable to import it. The JSX runtime's
 * surface is three stable names.
 */
export const REACT_SPECIFIER = "react";
export const JSX_RUNTIME_SPECIFIER = "react/jsx-runtime";

/** The JSX runtime's whole public surface; it is three names and does not drift. */
export const jsxRuntimeExports = ["jsx", "jsxs", "Fragment"] as const;

const VIRTUAL_PREFIX = "\0plugin-host-globals:";

const isIdentifier = (name: string): boolean =>
	/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);

/** React's own runtime export names, read from the installed package. */
export const reactExportNames = (
	react: Record<string, unknown>,
): readonly string[] => Object.keys(react).filter(isIdentifier);

/** Where the host's React and jsx runtime sit; matches `hostGlobalNames`. */
export interface HostGlobalModules {
	readonly react: string;
	readonly jsxRuntime: string;
	readonly reactExports: readonly string[];
}

/** `const host = globalThis["…"]; export const a = host.a; …` for one global. */
const moduleSource = (
	global: string,
	names: readonly string[],
	withDefault: boolean,
): string => {
	const lines = [`const host = globalThis[${JSON.stringify(global)}];`];
	if (withDefault) lines.push("export default host.default ?? host;");
	for (const name of names) lines.push(`export const ${name} = host.${name};`);
	return lines.join("\n");
};

/** The virtual-module plugin the preset loads, backed by the host globals. */
export const hostGlobalModules = (config: HostGlobalModules): Plugin => ({
	name: "plugins:host-globals",
	enforce: "pre",
	resolveId(source) {
		if (source === REACT_SPECIFIER) return `${VIRTUAL_PREFIX}react`;
		if (source === JSX_RUNTIME_SPECIFIER) return `${VIRTUAL_PREFIX}jsx-runtime`;
		return null;
	},
	load(id) {
		if (id === `${VIRTUAL_PREFIX}react`) {
			return moduleSource(config.react, config.reactExports, true);
		}
		if (id === `${VIRTUAL_PREFIX}jsx-runtime`) {
			return moduleSource(config.jsxRuntime, jsxRuntimeExports, false);
		}
		return null;
	},
});

/**
 * The bare specifiers an emitted chunk still imports — the build-time twin of
 * the loader's no-imports check (`web/src/lib/plugins/moduleImport.ts`). The
 * preset fails the build on a non-empty result, so the contract is enforced
 * where the violation is introduced rather than when a user loads the plugin.
 * Line-anchored, so a `from "…"` inside a string or comment is not a match.
 */
const FROM_IMPORT = /^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/gm;

const isBareSpecifier = (specifier: string): boolean =>
	!specifier.startsWith(".") &&
	!specifier.startsWith("/") &&
	!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);

export const bareImports = (code: string): readonly string[] => {
	const found: string[] = [];
	for (const pattern of [FROM_IMPORT, SIDE_EFFECT_IMPORT]) {
		for (const match of code.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier !== undefined && isBareSpecifier(specifier)) {
				found.push(specifier);
			}
		}
	}
	return found;
};
