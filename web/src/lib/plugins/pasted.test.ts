import { describe, expect, test } from "bun:test";
import { MANIFEST_FILE } from "@lib/plugins/loader";
import { pastedFiles } from "@lib/plugins/pasted";

/**
 * The one refusal the pasted-install form has to make is not visible in a
 * rendered button: an entry name of `plugin.json` would build a record whose
 * manifest is overwritten by the entry source, and the install would fail with
 * nothing pointing at the name. The verdict lives in a pure function so it can
 * be held here, without a renderer — the component reads the very same one.
 */

describe("the files a pasted install builds", () => {
	test("keys the manifest by its own name and the entry by the name it is given", () => {
		expect(pastedFiles("{}", "main.js", "export default {}")).toEqual({
			[MANIFEST_FILE]: "{}",
			"main.js": "export default {}",
		});
	});

	test("trims the entry name", () => {
		expect(pastedFiles("{}", "  main.js  ", "x")).toEqual({
			[MANIFEST_FILE]: "{}",
			"main.js": "x",
		});
	});

	test("refuses an entry name that is the manifest's own name", () => {
		expect(pastedFiles("{}", MANIFEST_FILE, "x")).toBeNull();
		expect(pastedFiles("{}", `  ${MANIFEST_FILE} `, "x")).toBeNull();
	});

	test("refuses a blank manifest or entry name", () => {
		expect(pastedFiles("   ", "main.js", "x")).toBeNull();
		expect(pastedFiles("{}", "   ", "x")).toBeNull();
	});
});
