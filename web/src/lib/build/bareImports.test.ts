import { describe, expect, test } from "bun:test";
import { bareImports } from "@lib/build/bareImports";

/**
 * The build-time no-imports guard (spec §6). Every case here is one the
 * reviewer had to run by hand before the rule moved into `web/`: a real import
 * of React, a re-export, a side-effect import, a minified statement with no
 * spaces, and the near-misses that must **not** count (`./rel.js`, `/abs.js`,
 * `data:` and a `from "react"` that sits inside a string or a comment).
 *
 * A false negative here would let a chunk the loader refuses ship; a false
 * positive would fail a legitimate build. Both directions are asserted.
 */
describe("bareImports", () => {
	test("finds a named import of a bare package", () => {
		expect(bareImports('import { useState } from "react";')).toEqual(["react"]);
	});

	test("finds a re-export from a bare package", () => {
		expect(bareImports('export { createElement } from "react";')).toEqual([
			"react",
		]);
	});

	test("finds a side-effect import", () => {
		expect(bareImports('import "lodash";')).toEqual(["lodash"]);
	});

	test("finds a minified import with no spaces", () => {
		expect(bareImports('import{a}from"react";')).toEqual(["react"]);
	});

	test("reports every bare specifier in statement order", () => {
		expect(bareImports('import "a";\nimport "b";')).toEqual(["a", "b"]);
	});

	test("ignores a relative, an absolute and a scheme specifier", () => {
		expect(bareImports('import { a } from "./rel.js";')).toEqual([]);
		expect(bareImports('import { a } from "/abs.js";')).toEqual([]);
		expect(
			bareImports(
				'import { a } from "data:text/javascript,export default {}";',
			),
		).toEqual([]);
	});

	test('is not fooled by `from "react"` inside a string', () => {
		expect(bareImports("const text = 'from \"react\"';")).toEqual([]);
	});

	test('is not fooled by `from "react"` inside a comment', () => {
		expect(bareImports('// import { a } from "react"\nconst x = 1;')).toEqual(
			[],
		);
		expect(bareImports('/* export { a } from "react" */')).toEqual([]);
	});
});
