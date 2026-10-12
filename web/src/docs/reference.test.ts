import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	buildReference,
	HOST_PATH,
	IDS_PATH,
	MANIFEST_PATH,
} from "@/docs/build";
import {
	authorGuidePath,
	pendingModules,
	referenceEntries,
} from "@/docs/entries";
import { reference } from "@/docs/reference.generated";
import {
	extractModuleSymbols,
	extractStringConst,
	extractStringTuple,
	extractZodObjectFields,
} from "@/docs/surface";
import { docReferenceSchema } from "@/docs/types";

/**
 * The coverage gate. It re-reads the shipped source and holds the committed
 * reference to it, so "the reference keeps up as the work progresses" is a
 * failing test rather than an aspiration: add an export, do not re-run
 * `bun run docs`, and this suite names the export that is missing.
 *
 * It compares the artifact in the tree (not a freshly built one), because the
 * artifact is what a deploy would ship — `web/package.json`'s `build` runs the
 * generator first, so the only way to see this fail is a commit that skipped it.
 */

const webRoot = new URL("../../", import.meta.url);

const read = (path: string): string | null => {
	const url = new URL(path, webRoot);
	return existsSync(url) ? readFileSync(url, "utf8") : null;
};

const exists = (path: string): boolean => existsSync(new URL(path, webRoot));

const sourceOf = (path: string): string => {
	const source = read(path);
	if (source === null) throw new Error(`${path} is missing from the tree`);
	return source;
};

const generated = docReferenceSchema.parse(reference);

describe("generated plugin API reference", () => {
	test("covers every export of every entry module", () => {
		const gaps: string[] = [];
		const byPath = new Map(
			generated.modules.map((module) => [module.path, module]),
		);
		for (const entry of referenceEntries(exists)) {
			const source = read(entry.path);
			const module = byPath.get(entry.path);
			if (source === null) {
				if (module === undefined) {
					gaps.push(
						`${entry.path}: missing from the reference entirely — re-run \`bun run docs\``,
					);
				} else if (module.status === "documented") {
					gaps.push(
						`${entry.path}: marked documented but the module is not in the tree — re-run \`bun run docs\``,
					);
				}
				continue;
			}
			if (module === undefined) {
				gaps.push(
					`${entry.path}: missing from the reference entirely — re-run \`bun run docs\``,
				);
				continue;
			}
			if (module.status !== "documented") {
				gaps.push(
					`${entry.path}: marked "${module.status}" but the module exists — re-run \`bun run docs\``,
				);
				continue;
			}
			const expected = extractModuleSymbols(entry.path, source, read).map(
				(symbol) => symbol.name,
			);
			const actual = module.symbols.map((symbol) => symbol.name);
			const missing = expected.filter((name) => !actual.includes(name));
			const stale = actual.filter((name) => !expected.includes(name));
			if (missing.length > 0) {
				gaps.push(
					`${entry.path}: exports not documented: ${missing.join(", ")}`,
				);
			}
			if (stale.length > 0) {
				gaps.push(
					`${entry.path}: documented but no longer exported: ${stale.join(", ")}`,
				);
			}
		}
		expect(gaps).toEqual([]);
	});

	test("names the modules it cannot cover yet instead of dropping them", () => {
		expect(generated.pending.toSorted()).toEqual(
			pendingModules(exists)
				.map((module) => module.path)
				.toSorted(),
		);
	});

	test("renders the slot map from slotIds, not a copy of it", () => {
		expect(generated.slots.map((slot) => slot.id)).toEqual(
			extractStringTuple(sourceOf(IDS_PATH), "slotIds"),
		);
		for (const slot of generated.slots) {
			expect(slot.description.length).toBeGreaterThan(0);
		}
	});

	test("renders the manifest fields from their zod declaration", () => {
		expect(generated.manifestFields.map((field) => field.name)).toEqual(
			extractZodObjectFields(sourceOf(MANIFEST_PATH), "manifestSchema").map(
				(field) => field.name,
			),
		);
	});

	test("reads the plugin API version from host.ts and the app version from package.json", () => {
		expect(generated.apiVersion).toBe(
			extractStringConst(sourceOf(HOST_PATH), "pluginApiVersion") ?? "",
		);
		const pkg = JSON.parse(sourceOf("package.json")) as { version: string };
		expect(generated.appVersion).toBe(pkg.version);
	});

	test("renders every event name the host emits", () => {
		expect(generated.events.map((event) => event.name)).toEqual(
			extractStringTuple(sourceOf(IDS_PATH), "hostEventNames"),
		);
	});

	test("classifies capabilities by what is actually enforced", () => {
		const byId = new Map(
			generated.capabilities.map((capability) => [capability.id, capability]),
		);
		expect(byId.get("net")?.boundary).toBe("unenforceable");
		expect(byId.get("plugin-data")?.boundary).toBe("path-scoped");
		for (const capability of generated.capabilities) {
			expect(capability.enforced.length).toBeGreaterThan(0);
		}
	});

	test("is not silently empty", () => {
		const documented = generated.modules.filter(
			(module) => module.status === "documented",
		);
		expect(documented.length).toBeGreaterThan(0);
		expect(
			documented.flatMap((module) => module.symbols).length,
		).toBeGreaterThan(0);
	});

	test("links the author guide exactly when Task 19's README is in the tree", () => {
		expect(generated.authorGuide.available).toBe(exists(authorGuidePath));
	});

	test("the generator is deterministic — rebuilding from source reproduces the artifact", () => {
		const rebuilt = buildReference({
			read,
			exists,
			appVersion: (JSON.parse(sourceOf("package.json")) as { version: string })
				.version,
		});
		expect(rebuilt).toEqual(generated);
	});
});
