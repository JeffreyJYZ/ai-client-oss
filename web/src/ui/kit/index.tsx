import type { ComponentProps, ReactNode } from "react";
import { BUTTON, cls, LABEL, SECTION, SECTION_SUMMARY } from "@/ui/kit/classes";

/**
 * The component kit (spec §4): the host's own primitives, so plugin UI is
 * visually consistent without copying Tailwind strings. Every class is lifted
 * verbatim from the app's existing components (`ui/kit/classes.ts` records
 * where each came from) and the helpers compose those same strings rather than
 * defining new styling — a consumer swapping in the kit renders identical
 * markup.
 */

export {
	BUTTON,
	BUTTON_PLAIN,
	CONTROL,
	cls,
	INPUT,
	LABEL,
	SECTION,
	SECTION_SUMMARY,
	SECTION_SUMMARY_WRAP,
} from "@/ui/kit/classes";

/** The bordered panel the Settings editor forms already use. */
const PANEL = "flex flex-col gap-4 rounded-md border border-neutral-800 p-4";

/** The app's standard button, on the kit's `BUTTON` class. */
export function Button({ className, ...rest }: ComponentProps<"button">) {
	return <button type="button" className={cls(BUTTON, className)} {...rest} />;
}

/** A bordered surface for one grouped block of plugin UI. */
export function Panel({ className, children, ...rest }: ComponentProps<"div">) {
	return (
		<div className={cls(PANEL, className)} {...rest}>
			{children}
		</div>
	);
}

interface SectionProps {
	/** The `<details>` chrome; defaults to the app's standard `SECTION`. */
	readonly className?: string;
	/** The summary row; defaults to the app's standard `SECTION_SUMMARY`. */
	readonly summaryClassName?: string;
	readonly heading: ReactNode;
	readonly children: ReactNode;
	readonly open?: boolean;
}

/**
 * A foldable settings section: the summary carries the section's
 * heading row (its `<h3>` and controls), the children its content.
 * Open by default — a fold that starts closed would hide content
 * the user never chose to hide.
 *
 * The chrome is built in: `className`/`summaryClassName` default to the app's
 * canonical `SECTION`/`SECTION_SUMMARY`, so a plugin renders a native-looking
 * section without copying a class string. Pass `SECTION_SUMMARY_WRAP` (or a
 * `cls` composition) only for a heading row that genuinely needs to wrap.
 */
export function Section({
	className = SECTION,
	summaryClassName = SECTION_SUMMARY,
	heading,
	children,
	open = true,
}: SectionProps) {
	return (
		<details className={className} open={open}>
			{/* A control in the heading row (a checkbox, a button) keeps its
			    own activation and does not fold the section: a click on one
			    makes it the event's activation target, so the summary's toggle
			    never runs. Do not add an onClick that calls preventDefault to
			    "protect" the control: that cancels the control's own action
			    too and leaves a heading checkbox untickable (browser-verified
			    in both cases). */}
			<summary className={summaryClassName}>{heading}</summary>
			{children}
		</details>
	);
}

/** One labelled field: the `LABEL` wrapper with a control as its child. */
export function FieldRow({
	label,
	children,
}: {
	readonly label: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the caller's child (same pattern as the Settings forms)
		<label className={LABEL}>
			{label}
			{children}
		</label>
	);
}
