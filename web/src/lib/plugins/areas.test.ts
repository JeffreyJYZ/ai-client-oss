import { describe, expect, test } from "bun:test";
import {
	BUILTIN_AREAS,
	BUILTIN_ID_PATTERN,
	LOCKED_BUILTIN_IDS,
} from "@lib/plugins/areas";
import type { Host } from "@lib/plugins/host";

/**
 * The area table's own invariants (spec "Units and identities", "Testing").
 *
 * The test that matters most is the coverage one: a tenth built-in registrar
 * must not be silently untoggleable. It discovers the registrars by importing
 * every module under `builtin/` and reading its exports, and compares them **by
 * identity** with the functions the areas carry — so neither a hardcoded list
 * here nor a wrapper added in `areas.ts` can hide a registrar from the table.
 */

const BUILTIN_DIR = `${import.meta.dir}/builtin`;

/** A module is a test module when bun would run it, not catalogue it. */
const isTestModule = (file: string): boolean =>
	file.includes(".test.") || file.includes(".spec.");

/**
 * A registrar is a named export matching `register…Builtins`. The aggregator
 * `registerBuiltins` deliberately does not match: `.+` requires the area word
 * between `register` and `Builtins`.
 */
const REGISTRAR_NAME = /^register.+Builtins$/;

type Registrar = (host: Host) => void;

/** Every exported area registrar under `builtin/`, with the name it is exported as. */
const discoverRegistrars = async (): Promise<
	readonly [string, Registrar][]
> => {
	const found: [string, Registrar][] = [];
	const glob = new Bun.Glob("**/*.{ts,tsx}");
	for await (const file of glob.scan({ cwd: BUILTIN_DIR })) {
		if (isTestModule(file)) continue;
		const module = (await import(`${BUILTIN_DIR}/${file}`)) as Record<
			string,
			unknown
		>;
		for (const [name, value] of Object.entries(module)) {
			if (REGISTRAR_NAME.test(name) && typeof value === "function") {
				found.push([name, value as Registrar]);
			}
		}
	}
	return found;
};

describe("BUILTIN_AREAS", () => {
	test("every area id is unique and matches the builtin id pattern", () => {
		const ids = BUILTIN_AREAS.map((area) => area.id);

		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(BUILTIN_ID_PATTERN.test(id)).toBe(true);
	});

	test("the builtin id pattern is an allowlist, not a match-anything", () => {
		// Guards against a pattern that would pass every id (a test passing for
		// the wrong reason): only `app.` + a lowercase word is accepted.
		expect(BUILTIN_ID_PATTERN.test("app.shell")).toBe(true);
		expect(BUILTIN_ID_PATTERN.test("shell")).toBe(false);
		expect(BUILTIN_ID_PATTERN.test("app.")).toBe(false);
		expect(BUILTIN_ID_PATTERN.test("app.Shell")).toBe(false);
		expect(BUILTIN_ID_PATTERN.test("app.shell.extra")).toBe(false);
		expect(BUILTIN_ID_PATTERN.test("plugin.shell")).toBe(false);
	});

	test("the table covers every registrar under builtin/** exactly once", async () => {
		const discovered = await discoverRegistrars();
		const nonLocked = BUILTIN_AREAS.filter((area) => area.locked !== true);

		// Discovery must find as many registrars as there are toggleable areas:
		// a tenth registrar with no area fails here, and an area pointing at a
		// non-registrar fails the identity check below.
		expect(discovered.length).toBe(nonLocked.length);

		for (const [name, register] of discovered) {
			const owners = BUILTIN_AREAS.filter((area) => area.register === register);
			expect(
				owners.length,
				`${name} must appear in exactly one area's register`,
			).toBe(1);
		}

		const areaRegisters = new Set(BUILTIN_AREAS.map((area) => area.register));
		for (const [name, register] of discovered) {
			expect(areaRegisters.has(register), `${name} is in the table`).toBe(true);
		}
	});

	test("the locked set is exactly the substrate and the manager", () => {
		expect(LOCKED_BUILTIN_IDS).toEqual(["app.substrate", "app.builtins"]);
		expect(
			BUILTIN_AREAS.filter((area) => area.locked === true).map((a) => a.id),
		).toEqual([...LOCKED_BUILTIN_IDS]);
	});

	test("every toggleable area says, in one sentence, what turning it off removes", () => {
		for (const area of BUILTIN_AREAS) {
			if (area.locked === true) continue;
			expect(
				area.description.trim().length,
				`${area.id} description`,
			).toBeGreaterThan(0);
		}
	});
});
