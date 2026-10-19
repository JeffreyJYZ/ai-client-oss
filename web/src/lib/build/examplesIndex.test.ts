import { describe, expect, test } from "bun:test";
import { exampleEntry, examplesIndex } from "@lib/build/examplesIndex";

const row = (id: string) => ({
	id,
	name: id,
	description: `${id} does one thing.`,
	manifest: `{"id":"${id}"}`,
});

describe("the shipped example index", () => {
	test("lists rows sorted by id, so the artifact is stable", () => {
		const index = examplesIndex([row("example.zen-view"), row("example.a")]);

		expect(index.version).toBe(1);
		expect(index.examples.map((example) => example.id)).toEqual([
			"example.a",
			"example.zen-view",
		]);
	});

	test("derives every entry path from the id, never from the caller", () => {
		const [example] = examplesIndex([row("example.a")]).examples;

		expect(example?.entry).toBe("/plugins/example.a/main.js");
		expect(example?.entry).toBe(exampleEntry("example.a"));
	});

	test("carries the manifest text unchanged — install takes files, not objects", () => {
		const manifest = '{\n\t"id": "example.a",\n\t"apiVersion": "0.1"\n}';
		const [example] = examplesIndex([
			{ ...row("example.a"), manifest },
		]).examples;

		expect(example?.manifest).toBe(manifest);
		expect(JSON.parse(example?.manifest ?? "")).toEqual({
			id: "example.a",
			apiVersion: "0.1",
		});
	});

	test("survives a JSON round trip — it ships as a static file", () => {
		const index = examplesIndex([row("example.b"), row("example.a")]);

		expect(JSON.parse(JSON.stringify(index))).toEqual(index);
	});
});
