import { describe, expect, test } from "bun:test";
import {
	activeVariant,
	emptyVariant,
	Settings,
	type Variant,
	variantParamsOf,
} from "@lib/db/types";

/**
 * The stored side of a variant: the shape, the pointer, and what the request
 * path reads out of them.
 *
 * The claim under test is that a settings blob written **before** this feature
 * exists still reads (the fields are additive and defaulted), that a pointer to
 * a variant that is gone reads as *no* variant rather than throwing, and that
 * what reaches the request is the parameters alone — never the variant's id or
 * name, which are the editor's business.
 */

const variant = (over: Partial<Variant> = {}): Variant => ({
	...emptyVariant("v1"),
	...over,
});

describe("the stored variant shape", () => {
	test("a settings blob without the fields reads as no variants and no active one", () => {
		const settings = Settings.parse({ providers: [] });

		expect(settings.variants).toEqual([]);
		expect(settings.activeVariantId).toBe("");
	});

	test("a stored variant round-trips with exactly the parameters it sets", () => {
		const settings = Settings.parse({
			providers: [],
			variants: [
				variant({
					temperature: 0.4,
					maxTokens: 2048,
					reasoningEffort: "low",
				}),
			],
			activeVariantId: "v1",
		});

		expect(settings.variants).toHaveLength(1);
		expect(settings.variants[0]?.temperature).toBe(0.4);
		expect(settings.variants[0]?.topP).toBeUndefined();
		expect(settings.variants[0]?.maxTokens).toBe(2048);
		expect(settings.variants[0]?.reasoningEffort).toBe("low");
	});

	test("the schema refuses a parameter outside its range", () => {
		const parsed = Settings.safeParse({
			providers: [],
			variants: [variant({ temperature: 9 })],
		});

		expect(parsed.success).toBe(false);
	});

	test("the schema refuses a non-integer token cap", () => {
		const parsed = Settings.safeParse({
			providers: [],
			variants: [variant({ maxTokens: 12.5 })],
		});

		expect(parsed.success).toBe(false);
	});

	test("the schema refuses an unknown effort", () => {
		const parsed = Settings.safeParse({
			providers: [],
			variants: [variant({ reasoningEffort: "extreme" as never })],
		});

		expect(parsed.success).toBe(false);
	});
});

describe("the active variant pointer", () => {
	test("it resolves to the variant it names", () => {
		const settings = Settings.parse({
			providers: [],
			variants: [variant({ id: "v1" }), variant({ id: "v2" })],
			activeVariantId: "v2",
		});

		expect(activeVariant(settings)?.id).toBe("v2");
	});

	test("no active variant reads as none", () => {
		const settings = Settings.parse({ providers: [], variants: [] });

		expect(activeVariant(settings)).toBeUndefined();
	});

	test("a pointer to a variant that is gone reads as none, not a throw", () => {
		const settings = Settings.parse({
			providers: [],
			variants: [variant({ id: "v1" })],
			activeVariantId: "removed",
		});

		expect(activeVariant(settings)).toBeUndefined();
	});
});

describe("what the request path reads", () => {
	test("only the parameters leave the variant — never its id or name", () => {
		const params = variantParamsOf(
			variant({ id: "v1", name: "Fast", temperature: 0.4 }),
		);

		expect(Object.keys(params).sort()).toEqual(["temperature"]);
		expect(params.temperature).toBe(0.4);
	});
});
