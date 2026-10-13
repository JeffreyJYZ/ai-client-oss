import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_CHANGED_EVENT } from "@lib/plugins/runtime";

/**
 * The `plugin-changed` event name is declared twice — once here (the JS reader,
 * `runtime.ts`) and once in the shell (`web/src-tauri/src/lib.rs`, the watcher
 * that emits it) — with no shared source. A drift makes the desktop watcher's
 * listener **never fire, silently**: the app keeps running and hot reload just
 * stops. This pins the two together by reading the Rust constant out of the
 * source the repo already holds.
 *
 * The Rust file is read rather than executed: it is in this repo, and the shell
 * is the other half of one wire. A build step that shared one generated constant
 * would be heavier than the wire warrants, so the pin lives here, in the tree
 * `bun run verify` gates.
 */
describe("the plugin-changed event name", () => {
	test("matches the constant the Rust watcher emits", () => {
		const libRs = readFileSync(
			join(import.meta.dir, "../../../src-tauri/src/lib.rs"),
			"utf8",
		);
		const declared = libRs.match(
			/const PLUGIN_CHANGED_EVENT: &str = "([^"]+)"/,
		);
		expect(declared).not.toBeNull();
		expect(declared?.[1]).toBe(PLUGIN_CHANGED_EVENT);
	});
});
