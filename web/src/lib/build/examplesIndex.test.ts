import { describe, expect, test } from "bun:test";
import {
	exampleEntry,
	exampleInstalled,
	examplesIndex,
} from "@lib/build/examplesIndex";

/**
 * A row as `scripts/build-plugins.ts` produces one. `pluginId` is the
 * manifest's own id and is deliberately **not** the directory name — that
 * difference is the reason the two fields exist.
 */
const row = (id: string, pluginId = `example.${id}`) => ({
	id,
	pluginId,
	name: id,
	description: `${id} does one thing.`,
	manifest: `{"id":"${pluginId}"}`,
});

describe("the shipped example index", () => {
	test("lists rows sorted by id, so the artifact is stable", () => {
		const index = examplesIndex([row("zen-view"), row("a")]);

		expect(index.version).toBe(1);
		expect(index.examples.map((example) => example.id)).toEqual([
			"a",
			"zen-view",
		]);
	});

	test("derives every entry path from the id, never from the caller", () => {
		const [example] = examplesIndex([row("a")]).examples;

		expect(example?.entry).toBe("/plugins/a/main.js");
		expect(example?.entry).toBe(exampleEntry("a"));
	});

	test("carries the manifest id beside the directory name", () => {
		// The two differ, which is the whole point: an install is stored under
		// the manifest id, so "is this installed?" can only be answered by it.
		const [example] = examplesIndex([row("custom-tool")]).examples;

		expect(example?.id).toBe("custom-tool");
		expect(example?.pluginId).toBe("example.custom-tool");
	});

	test("carries the manifest text unchanged — install takes files, not objects", () => {
		const manifest = '{\n\t"id": "example.a",\n\t"apiVersion": "0.1"\n}';
		const [example] = examplesIndex([{ ...row("a"), manifest }]).examples;

		expect(example?.manifest).toBe(manifest);
		expect(JSON.parse(example?.manifest ?? "")).toEqual({
			id: "example.a",
			apiVersion: "0.1",
		});
	});

	test("survives a JSON round trip — it ships as a static file", () => {
		const index = examplesIndex([row("b"), row("a")]);

		expect(JSON.parse(JSON.stringify(index))).toEqual(index);
	});
});

describe("whether an example is already installed", () => {
	test("matches on the manifest id, never the directory name", () => {
		const [example] = examplesIndex([row("custom-tool")]).examples;
		if (example === undefined) throw new Error("no example");

		// The store lists installed plugins by manifest id; the directory name
		// is a build path and must not be taken for an install.
		expect(exampleInstalled(example, new Set(["custom-tool"]))).toBe(false);
		expect(exampleInstalled(example, new Set(["example.custom-tool"]))).toBe(
			true,
		);
	});

	test("an unknown plugin id is never installed", () => {
		// An index written before it carried the manifest id: the row cannot
		// verify anything, so it keeps its Install button.
		const [example] = examplesIndex([row("a", "")]).examples;
		if (example === undefined) throw new Error("no example");

		expect(exampleInstalled(example, new Set(["a", ""]))).toBe(false);
		expect(exampleInstalled(example, new Set(["example.a"]))).toBe(false);
	});

	test("an empty install set is nothing installed", () => {
		const [example] = examplesIndex([row("a")]).examples;
		if (example === undefined) throw new Error("no example");

		expect(exampleInstalled(example, new Set())).toBe(false);
	});
});
