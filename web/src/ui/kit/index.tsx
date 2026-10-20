import type { ComponentProps, ReactNode } from "react";
import {
	BUTTON,
	cls,
	DISCLOSURE,
	LABEL,
	SECTION,
	SECTION_SUMMARY,
	SUBSECTION,
} from "@/ui/kit/classes";

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
	DISCLOSURE,
	INPUT,
	LABEL,
	SECTION,
	SECTION_HEADING,
	SECTION_SUMMARY,
	SECTION_SUMMARY_WRAP,
	SUBHEADING,
	SUBSECTION,
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
 * The disclosure chevron every `Section` renders in front of its heading. An
 * SVG rather than a `▶` glyph: the mono stack's triangle sits off its optical
 * centre, so a rotated glyph reads lopsided in a row of small text. The
 * rotation is the `.fold-chevron` rule in `App.css`, and the icon is
 * `aria-hidden` because `<details>`/`<summary>` already announce expanded
 * state — a second "expanded" from the icon would be noise.
 *
 * Exported so a hand-rolled `<details>` (a fold inside a row, where `Section`'s
 * card chrome would be wrong) carries the same mark instead of a bare marker.
 */
export function Disclosure() {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 12 12"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.6}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={DISCLOSURE}
		>
			<path d="M4.25 2.5 7.75 6l-3.5 3.5" />
		</svg>
	);
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
 *
 * The chevron is the section's own mark: `▶` folded, `▼` open, drawn by CSS
 * from the `<details open>` state. The heading goes inside a wrapper that
 * takes the remaining width, so the icon can sit outside the heading's own
 * left/right layout and every existing heading keeps its arrangement.
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
			<summary className={summaryClassName}>
				<Disclosure />
				<span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
					{heading}
				</span>
			</summary>
			{children}
		</details>
	);
}

/**
 * A section nested inside another section's content: the same fold, indented
 * behind a rail (`SUBSECTION`), so a sub-heading visibly belongs to the
 * heading above it. Pass a `SUBHEADING` heading; nesting is the whole point,
 * so there is no unindented variant.
 */
export function SubSection({
	heading,
	children,
	open = true,
}: {
	readonly heading: ReactNode;
	readonly children: ReactNode;
	readonly open?: boolean;
}) {
	return (
		<Section
			className={SUBSECTION}
			summaryClassName={SECTION_SUMMARY}
			heading={heading}
			open={open}
		>
			{children}
		</Section>
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
