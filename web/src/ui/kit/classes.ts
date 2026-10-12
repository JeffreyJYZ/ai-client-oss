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
