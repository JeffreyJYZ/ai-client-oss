import { describe, expect, test } from "bun:test";
import type { Host } from "@lib/plugins/host";
import type { PluginModule } from "@lib/plugins/loader";
import { moduleImporter } from "@lib/plugins/moduleImport";
import { Effect } from "effect";

/**
 * The real importer is the browser's blob-import path (spec §6): a plugin's
 * entry text becomes a `blob:` module and is imported, with the host's globals
 * set before the module body evaluates. Bun runs the same blob import, so the
 * mechanism is tested for real rather than faked — only the `import.meta.env`
 * dev branch differs (a dev server is not present here, so these exercise the
 * blob path).
 */

/** A distinct host per call, so a stale global can never satisfy an identity test. */
const fakeHost = (): Host =>
	({ version: { app: "0.0.0", api: "0.1" } }) as unknown as Host;

const importerFor = (host: Host) => moduleImporter(host, "test.plugin");

describe("importModule (blob import)", () => {
	test("imports a module and hands the host to its setup", async () => {
		const host = fakeHost();
		const source = `
			export default {
				seenAtImport: globalThis.__aiClient,
				setup(received) { globalThis.__setupHost = received; },
			};
		`;
		const module = (await Effect.runPromise(
			importerFor(host).importSource(source, "main.js"),
		)) as PluginModule & { readonly seenAtImport?: unknown };

		// The module body read `__aiClient` at evaluation time, before `setup`
		// ran — which is the whole point of setting the globals first.
		expect(module.seenAtImport).toBe(host);

		module.setup(host);
		expect((globalThis as { __setupHost?: unknown }).__setupHost).toBe(host);
	});

	test("a source with a syntax error is a PluginLoadFailed, not a crash", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				importerFor(fakeHost()).importSource("export default {", "main.js"),
			),
		);
		expect(failure._tag).toBe("PluginLoadFailed");
		expect(failure.detail).toContain("main.js");
	});

	test("a bare import fails with a message naming the no-imports contract", async () => {
		const source = `
			import { React } from "react";
			export default { setup() {} };
		`;
		const failure = await Effect.runPromise(
			Effect.flip(importerFor(fakeHost()).importSource(source, "main.js")),
		);
		expect(failure._tag).toBe("PluginLoadFailed");
		// Readable, and it names the contract rather than the browser's
		// "Failed to resolve module specifier".
		expect(failure.detail).toContain("no imports");
		expect(failure.detail).toContain("react");
		expect(failure.detail).not.toContain("Failed to resolve module specifier");
	});

	test("a module with no default setup export is a PluginLoadFailed", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				importerFor(fakeHost()).importSource(
					"export const nope = 1;",
					"main.js",
				),
			),
		);
		expect(failure._tag).toBe("PluginLoadFailed");
		expect(failure.detail).toContain("setup");
	});
});
