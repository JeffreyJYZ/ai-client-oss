/**
 * The kit's shared class strings (spec §4). Every value is lifted verbatim
 * from the component it came from — no re-styling, no reordering, no
 * "improvement" — so a consumer that swaps its local constant for the kit's
 * renders byte-identical classes:
 *
 * - `INPUT` / `LABEL` / `BUTTON`  — `ui/Settings.tsx`
 * - `BUTTON_PLAIN`               — `ui/Composer.tsx` (a different button:
 *                                  borderless and larger than `BUTTON`, so it
 *                                  is a separate constant rather than a merge)
 * - `CONTROL`                    — `ui/ProfilePicker.tsx` / `ui/ProviderPicker.tsx`
 * - `SECTION` / `SECTION_SUMMARY` / `SECTION_SUMMARY_WRAP` — `ui/Settings.tsx`
 *   (the foldable section chrome; `Section` defaults to the first two)
 * - `SECTION_HEADING` / `DISCLOSURE` / `SUBSECTION` / `SUBHEADING` —
 *   `ui/kit/index.tsx` (the fold itself: heading style, chevron, nested rail)
 */

/** Join class names, dropping the falsy ones (no dependency, one line). */
export const cls = (
	...parts: ReadonlyArray<string | false | null | undefined>
): string =>
	parts.filter((part) => typeof part === "string" && part !== "").join(" ");

export const INPUT =
	"rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

export const LABEL =
	"flex flex-col gap-1 text-xs uppercase tracking-widest text-neutral-500";

export const BUTTON =
	"rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40";

export const BUTTON_PLAIN =
	"shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export const CONTROL =
	"max-w-[12rem] truncate rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-500 focus:outline-none";

/**
 * The standard foldable Settings section: a top-divided block. The first
 * section on a page skips the divider and passes a `className` of its own.
 * `Section` defaults to this, so a plugin's section needs no class string.
 */
export const SECTION = "flex flex-col gap-3 border-t border-neutral-800 pt-5";

/** A section's summary row: the heading on the left, its controls on the right. */
export const SECTION_SUMMARY =
	"flex cursor-pointer select-none items-center justify-between gap-3";

/** The summary row when a wide heading must wrap instead of clip. */
export const SECTION_SUMMARY_WRAP =
	"flex cursor-pointer select-none flex-wrap items-center justify-between gap-3";

/**
 * A section heading: small, dim, letter-spaced — the app's one heading style.
 * Every built-in section uses this string, so headings cannot drift apart.
 */
export const SECTION_HEADING =
	"text-xs uppercase tracking-widest text-neutral-500";

/**
 * The disclosure chevron `Section` renders before every heading: it points
 * right while the section is folded and turns down when it opens. The rotation
 * is the `.fold-chevron` rule in `App.css`, keyed on `details[open]` through
 * **direct children** — a descendant match (a Tailwind `group-open:` variant
 * included) also fires for an open ancestor, which turned a closed nested
 * section's chevron down. Nothing here holds state or runs an `onClick`, so the
 * native summary toggle stays the only handler and a control in the heading row
 * stays clickable.
 */
export const DISCLOSURE = "fold-chevron size-3 shrink-0 text-neutral-600";

/**
 * A section nested inside another section's content: indented behind a rail, so
 * a sub-heading is visibly *owned* by the heading above it. `SubSection` uses
 * this, and the rail is the whole hierarchy signal — no second font size.
 */
export const SUBSECTION =
	"ml-1 flex flex-col gap-2 border-l border-neutral-800 pl-3";

/** A nested section's heading: one step smaller than its parent's. */
export const SUBHEADING =
	"text-[0.7rem] uppercase tracking-widest text-neutral-500";
