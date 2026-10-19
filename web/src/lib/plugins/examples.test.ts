import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRecordingHost } from "@lib/plugins/examples-host";
import { slotIds } from "@lib/plugins/ids";
import { manifestSchema } from "@lib/plugins/manifest";

const PLUGINS_DIR = join(import.meta.dir, "../../../plugins");

// Examples run in a browser; bun's test environment has no DOM. The harness
// exercises `setup`, which may touch `document`, so provide a minimal stub.
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
	const element = {
		setAttribute() {},
		removeAttribute() {},
		append() {},
		click() {},
		href: "",
		download: "",
		style: {},
	};
	(globalThis as { document: unknown }).document = {
		documentElement: { setAttribute() {}, removeAttribute() {} },
		body: { append() {} },
		createElement: () => ({ ...element }),
	};
}

/** `globals-proof/` has no manifest and no `setup` by design (a build fixture); excluded by name, not by a silent glob miss. */
const EXCLUDED_DIRS = new Set(["globals-proof"]);

const discoverExampleDirs = (): string[] =>
	readdirSync(PLUGINS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => !EXCLUDED_DIRS.has(name))
		.filter((name) => existsSync(join(PLUGINS_DIR, name, "plugin.json")))
		.sort();

describe("plugin examples", () => {
	test("every example validates, runs setup, and registers something", async () => {
		const dirs = discoverExampleDirs();
		expect(dirs.length).toBeGreaterThan(0);

		const allIds: string[] = [];

		for (const name of dirs) {
			const dir = join(PLUGINS_DIR, name);
			const manifest = manifestSchema.parse(
				JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")),
			);

			// Manifest entry names the built file; map to the source file.
			let sourceFile = manifest.entry;
			const directPath = join(dir, sourceFile);
			if (!existsSync(directPath) && sourceFile.endsWith(".js")) {
				const tsPath = join(dir, sourceFile.replace(/\.js$/, ".ts"));
				const tsxPath = join(dir, sourceFile.replace(/\.js$/, ".tsx"));
				if (existsSync(tsPath)) sourceFile = sourceFile.replace(/\.js$/, ".ts");
				else if (existsSync(tsxPath))
					sourceFile = sourceFile.replace(/\.js$/, ".tsx");
			}

			const module = (await import(`${dir}/${sourceFile}`)) as {
				default?: { setup?: (host: unknown) => unknown };
			};
			expect(typeof module.default?.setup).toBe("function");
			const setup = (module.default as { setup: (host: unknown) => unknown })
				.setup;

			const recording = createRecordingHost();
			setup(recording.host);

			const r = recording.records;
			const contributionCount =
				r.ui.length +
				r.commands.length +
				r.tools.length +
				r.pipeline.length +
				r.renderers.length +
				r.providers.length +
				r.settingsSections.length +
				r.themes.length;
			expect(contributionCount).toBeGreaterThan(0);

			for (const contribution of r.ui) {
				expect(slotIds).toContain(contribution.slot);
			}

			for (const contribution of r.ui) allIds.push(contribution.id);
			for (const entry of r.commands) allIds.push(entry.id);
			for (const tool of r.tools) allIds.push(tool.declaration.name);
			for (const entry of r.pipeline) allIds.push(entry.id);
			for (const section of r.settingsSections) allIds.push(section.id);
			for (const theme of r.themes) allIds.push(theme.id);
			for (const entry of r.providers) allIds.push(entry.id);
		}

		expect(new Set(allIds).size).toBe(allIds.length);
	});

	test("README example table lists exactly the discoverable set", () => {
		const dirs = discoverExampleDirs();
		const readme = readFileSync(join(PLUGINS_DIR, "README.md"), "utf8");
		const referenced = new Set(
			[...readme.matchAll(/([A-Za-z0-9._-]+)\/main\.(?:ts|tsx)/g)].map(
				(match) => match[1],
			),
		);
		expect(referenced).toEqual(new Set(dirs));
	});
});
