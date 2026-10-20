import { describe, expect, test } from "bun:test";
import { emptyVariant, type Variant } from "@lib/db/types";
import {
	EFFORT_OPTIONS,
	editEffort,
	editNumber,
	type FieldEdit,
	VARIANT_NUMBER_FIELDS,
	variantLabel,
} from "@/ui/variants/variantFields";

/**
 * The Variants section's pure half: what one edited field becomes.
 *
 * The claim under test is that the **schema** decides, not the component: an
 * out-of-range value is refused with the schema's own message, and a cleared
 * field means *unset* (the parameter is removed, so the request carries no
 * parameter for it). The editor never repeats a range.
 */

const variant = (over: Partial<Variant> = {}): Variant => ({
	...emptyVariant("v1"),
	...over,
});

/** The patch a successful edit produced, or `undefined` when it was refused. */
const patchOf = (edit: FieldEdit): Record<string, unknown> | undefined =>
	edit.ok ? edit.patch : undefined;

describe("editing a number", () => {
	test("a value the schema accepts becomes the patch", () => {
		const edit = editNumber(variant(), "temperature", "0.4");

		expect(edit.ok).toBe(true);
		expect(patchOf(edit)).toEqual({ temperature: 0.4 });
	});

	test("a value above the range is refused with the schema's message", () => {
		const edit = editNumber(variant(), "temperature", "9");

		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.message).toBe("Temperature must be at most 2.");
		}
	});

	test("a value below the range is refused with the schema's message", () => {
		const edit = editNumber(variant(), "topP", "-0.5");

		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.message).toBe("Top P must be at least 0.");
		}
	});

	test("text that is not a number is refused with the schema's message", () => {
		const edit = editNumber(variant(), "maxTokens", "lots");

		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.message).toBe("Max tokens must be a number.");
		}
	});

	test("a fractional token cap is refused with the schema's message", () => {
		const edit = editNumber(variant(), "maxTokens", "12.5");

		expect(edit.ok).toBe(false);
		if (!edit.ok) {
			expect(edit.message).toBe("Max tokens must be a whole number.");
		}
	});

	test("an empty field unsets the parameter", () => {
		const edit = editNumber(variant(), "temperature", "  ");

		expect(edit.ok).toBe(true);
		expect(patchOf(edit)).toEqual({ temperature: undefined });
	});

	test("the field the editor names is the one the patch carries", () => {
		for (const field of VARIANT_NUMBER_FIELDS) {
			const edit = editNumber(variant(), field, "1");

			expect(edit.ok).toBe(true);
			expect(Object.keys(patchOf(edit) ?? {})).toEqual([field]);
		}
	});
});

describe("editing the reasoning effort", () => {
	test("a chosen effort becomes the patch", () => {
		const edit = editEffort(variant(), "medium");

		expect(edit.ok).toBe(true);
		expect(patchOf(edit)).toEqual({ reasoningEffort: "medium" });
	});

	test("the empty choice unsets the effort", () => {
		const edit = editEffort(variant(), "");

		expect(edit.ok).toBe(true);
		expect(patchOf(edit)).toEqual({ reasoningEffort: undefined });
	});

	test("the editor offers every effort, plus the empty choice first", () => {
		expect(EFFORT_OPTIONS).toEqual(["", "low", "medium", "high"]);
	});
});

describe("the label a variant shows", () => {
	test("a named variant shows its name", () => {
		expect(variantLabel(variant({ name: "Fast" }))).toBe("Fast");
	});

	test("an unnamed variant shows the fallback", () => {
		expect(variantLabel(variant({ name: "" }))).toBe("Untitled variant");
		expect(variantLabel(variant({ name: "   " }))).toBe("Untitled variant");
	});
});
