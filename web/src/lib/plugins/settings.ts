import type { Disposable, Host } from "@lib/plugins/host";
import { type ComponentType, createElement } from "react";
import { Section } from "@/ui/kit";

/**
 * The settings-sections service (spec §4/§5): `settings.registerSection(...)`
 * is a thin, typed wrapper over the `settings.sections` slot the nine built-in
 * sections already register into (Task 9), so a plugin's section renders,
 * reorders and hides exactly like a built-in's — same slot, same `order` sort
 * key, same `hidden` filter in the slot resolver.
 *
 * It is not a second settings mechanism: the entry it produces is an ordinary
 * `Contribution`, and a built-in could have been registered through it too.
 *
 * The one thing it adds is chrome: `title` is rendered by the kit's `Section`
 * (the same foldable `<details>` the built-ins use) so a plugin section looks
 * native without copying Tailwind strings. There is deliberately no `onClick`
 * on the summary — see the kit's `Section` for why (a heading control that
 * cancels the fold is a shipped bug).
 */

/** One plugin-contributed Settings section (spec §5). */
export interface SettingsSection {
	readonly id: string;
	/** The section's heading; the kit renders it in the foldable summary row. */
	readonly title: string;
	/** Sort key within `settings.sections`; absent sorts after ordered entries. */
	readonly order?: number;
	/** Registered but not rendered (spec §4's `hidden`), exactly as for a built-in. */
	readonly hidden?: boolean;
	readonly component: ComponentType<Record<string, unknown>>;
}

/**
 * The service `host.settings` exposes (spec §5): registering a section is a
 * `settings.sections` contribution, so it renders, reorders and hides exactly
 * like a built-in's and is owned and disposed by the plugin's `Scope`.
 */
export interface SettingsRegistry {
	readonly registerSection: (section: SettingsSection) => Disposable;
}

/** The built-in sections' chrome, reused so a plugin section matches them. */
const SECTION_CLASS = "flex flex-col gap-3 border-t border-neutral-800 pt-5";
const SECTION_SUMMARY =
	"flex cursor-pointer select-none items-center justify-between gap-3";
const HEADING_CLASS = "text-xs uppercase tracking-widest text-neutral-500";

/**
 * Wrap a plugin's body component in the kit's foldable section, headed by the
 * section's title. Built once per registration, so the component identity is
 * stable across renders. `createElement` rather than JSX because this module is
 * `.ts` (the plan's file name) — a component factory, not a rendered view.
 */
const withChrome = (
	title: string,
	Body: ComponentType<Record<string, unknown>>,
): ComponentType<Record<string, unknown>> =>
	function SettingsSectionChrome(props: Record<string, unknown>) {
		return createElement(Section, {
			className: SECTION_CLASS,
			summaryClassName: SECTION_SUMMARY,
			heading: createElement("h3", { className: HEADING_CLASS }, title),
			// React 19's `createElement` overload types the props argument as the
			// component's full props, so a required `children` must be passed here
			// rather than as a third argument. `Section` renders it identically.
			// biome-ignore lint/correctness/noChildrenProp: see above
			children: createElement(Body, props),
		});
	};

/**
 * The settings registry over one host (spec §5). Registration is a slot
 * contribution: `settings.sections` is already rendered by `SettingsShell` and
 * resolved by the slot machinery, so no new rendering path exists here.
 */
export const makeSettingsRegistry = (host: Host): SettingsRegistry => ({
	registerSection: (section) =>
		host.ui.register({
			id: section.id,
			slot: "settings.sections",
			order: section.order,
			hidden: section.hidden,
			component: withChrome(section.title, section.component),
		}),
});
