import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_PLUGIN_EXAMPLES } from "./shippedExamples";

describe("shippedExamples", () => {
	test("matches the on-disk plugin manifests", () => {
		const pluginsDir = new URL("../../plugins/", import.meta.url);
		const ids = readdirSync(pluginsDir)
			.filter((entry) =>
				existsSync(join(pluginsDir.pathname, entry, "plugin.json")),
			)
			.toSorted();
		expect(SHIPPED_PLUGIN_EXAMPLES.map((e) => e.id).toSorted()).toEqual(ids);
		for (const dir of ids) {
			const manifest = JSON.parse(
				readFileSync(join(pluginsDir.pathname, dir, "plugin.json"), "utf8"),
			) as { name?: string; description?: string };
			const row = SHIPPED_PLUGIN_EXAMPLES.find((e) => e.id === dir);
			expect(row).toBeDefined();
			expect(row?.name).toBe(manifest.name ?? dir);
			expect(row?.description).toBe(manifest.description ?? "");
		}
	});
});
