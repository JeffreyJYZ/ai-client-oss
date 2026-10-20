import { type Variant, variantSchema } from "@lib/db/types";
import {
	REASONING_EFFORTS,
	type ReasoningEffort,
	type VariantParams,
} from "@lib/providers/variant";

/**
 * The Variants section's **pure** half: what one edited field becomes.
 *
 * The repo has no React renderer harness, so the component's behaviour lives
 * here as values in and values out, and the tests drive it. Every rule about
 * what a parameter may be lives in the **schema** (`variantSchema` in
 * `lib/db/types.ts`), never here: this module parses what the user typed and
 * asks the schema whether the result is a legal variant, so the editor and the
 * stored shape can never disagree about the ranges.
 */

/** The numeric fields a variant carries, in the order the editor shows them. */
export const VARIANT_NUMBER_FIELDS = [
	"temperature",
	"topP",
	"maxTokens",
] as const;

export type VariantNumberField = (typeof VARIANT_NUMBER_FIELDS)[number];

/** The efforts the editor offers, with the empty choice first ("unset"). */
export const EFFORT_OPTIONS: readonly (ReasoningEffort | "")[] = [
	"",
	...REASONING_EFFORTS,
];

/**
 * The fields one edit changes. A parameter the edit unsets is `undefined`
 * here, and the store *removes* the field rather than storing it: the stored
 * shape carries only the parameters a variant sets.
 */
export type VariantPatch = Partial<Omit<Variant, "id">>;

/**
 * What one edited field became: the patch to store, or the schema's own
 * complaint about the value the user typed.
 */
export type FieldEdit =
	| { readonly ok: true; readonly patch: VariantPatch }
	| { readonly ok: false; readonly message: string };

/** The schema's first complaint, or a last-resort message. */
const complaint = (issues: readonly { readonly message: string }[]): string =>
	issues[0]?.message ?? "That value is not allowed.";

/**
 * A variant with one parameter field replaced, judged by the schema.
 *
 * An unset value *removes* the field: the stored shape carries only the
 * parameters a variant sets, so an unset parameter is absent from the request
 * body instead of being sent as a guess.
 */
const applyField = (
	variant: Variant,
	field: keyof VariantParams,
	value: number | ReasoningEffort | undefined,
): FieldEdit => {
	const next: Record<string, unknown> = { ...variant };
	if (value === undefined) {
		delete next[field];
	} else {
		next[field] = value;
	}
	const parsed = variantSchema.safeParse(next);
	if (!parsed.success) {
		return { ok: false, message: complaint(parsed.error.issues) };
	}
	return { ok: true, patch: { [field]: value } as VariantPatch };
};

/**
 * Apply a typed number to a variant, judged by the schema.
 *
 * An empty field means *unset*: the parameter is not sent at all, so the
 * endpoint's own default stands. Anything else must be a number the schema
 * accepts — the ranges are the schema's, so the editor never repeats them.
 */
export const editNumber = (
	variant: Variant,
	field: VariantNumberField,
	raw: string,
): FieldEdit => {
	const text = raw.trim();
	return applyField(variant, field, text === "" ? undefined : Number(text));
};

/**
 * Apply a chosen reasoning effort to a variant, judged by the schema. The
 * empty choice means *unset*.
 */
export const editEffort = (
	variant: Variant,
	effort: ReasoningEffort | "",
): FieldEdit =>
	applyField(variant, "reasoningEffort", effort === "" ? undefined : effort);

/** The name a variant shows when it has none of its own. */
export const variantLabel = (variant: Variant): string =>
	variant.name.trim() === "" ? "Untitled variant" : variant.name;
