/**
 * Task 17's browser-proof fixture (spec §6). It is deliberately import-free —
 * the no-imports contract — and reads `globalThis.__aiClient` while its module
 * body evaluates, before `setup` runs, so a browser load proves the host
 * globals were set *before* the import. `apiAtImport` is what the proof asserts.
 */
type FixtureHost = { readonly version: { readonly api: string } };

const api = (globalThis as { __aiClient?: FixtureHost }).__aiClient;

export default {
	/** Read at module evaluation — non-null only if the globals preceded the import. */
	apiAtImport: api?.version.api ?? null,
	setup(host: FixtureHost): void {
		(globalThis as Record<string, unknown>).__fixtureSetupHost = host;
	},
};
