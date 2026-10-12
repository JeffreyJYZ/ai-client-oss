/**
 * The no-imports guard for a built plugin entry (spec §6).
 *
 * A plugin is one pre-built ES module **with no imports**: the loader imports it
 * from a `blob:` URL, which cannot resolve a bare specifier, and the host is what
 * supplies React and the API. `scripts/build-plugins.ts` runs this over the
 * emitted chunk and fails the build on a match, so a preset regression fails
 * where the violation is introduced rather than when a user loads the plugin.
 *
 * It is a pure function of the chunk text — no Rollup graph, no filesystem — so
 * it lives here, where the repo's gate (`tsc -b`, `biome check`, `bun test`)
 * proves it. The repo-root `scripts/` are outside that gate; moving the rule in
 * is what turns a hand-run check into an enforced one. `@lib/plugins/moduleImport`
 * carries the same rule for the loader's own check; the two are the build-time
 * and load-time twins of one contract.
 */

/**
 * An ESM import/export statement's specifier, anchored to a line start so a
 * `from "…"` inside a string or comment is not mistaken for an import. The
 * built entry has no imports at all, so a match is always a contract breach.
 */
const FROM_IMPORT =
	/^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/gm;

/**
 * A bare specifier is one no URL can resolve: not relative, not root-absolute,
 * and carrying no scheme. `react`, `react/jsx-runtime` and
 * `@ai-client/plugin-sdk` are bare; `./x.js`, `/x.js` and `data:` are not.
 */
export const isBareSpecifier = (specifier: string): boolean =>
	!specifier.startsWith(".") &&
	!specifier.startsWith("/") &&
	!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);

/** Every bare specifier the code imports, in statement order. */
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
