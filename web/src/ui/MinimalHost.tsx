import { BUILTIN_IDENTITIES } from "@lib/plugins/builtinIdentity";
import type { Contribution } from "@lib/plugins/host";
import type { ComponentType } from "react";
import { useBuiltins } from "@/state/builtins";
import { PluginsSection } from "@/ui/plugins/PluginsSection";
import { useContribution } from "@/ui/slots/useContribution";

/**
 * The container's minimal host surface (spec "The locked core").
 *
 * **Why it exists.** The locked set guarantees an entry stays *registered*;
 * reachability is a separate property, and nothing tested it. `app.shell` owns
 * the only `ui.root.layout` contribution and `app.settings` the only
 * `settings.root.shell`, so turning either off removed the sole route to the
 * Plugins manager while its section stayed registered — the bare preset left
 * `#root` at 0 characters (measured in a browser, not reasoned). The container
 * is the locked thing that must therefore *render* the way back.
 *
 * **How it stays minimal and honest.** It mounts the manager's **own
 * component**, `PluginsSection`, by identity: not a second UI, not a
 * re-implementation, and not the registry's `settings.section.plugins` entry
 * (that entry renders into `settings.sections`, whose container belongs to
 * `app.settings` — the very thing that can be off). Mounting the component
 * needs neither area, which is what makes the route survive both going away.
 * Beside it, one line names what the resolved state records off.
 *
 * **When it renders.** Only when the root layout slot holds no visible
 * contribution, so a live layout — the shell, or a plugin's replacement — keeps
 * the page exactly as it was and this renders nothing at all.
 *
 * **The two halves of the route.** This file is the half for *no layout* (shell
 * off, the bare preset): the slot is empty, so the container renders the manager
 * itself. The other half is the settings **surface** (`settings.root.shell`),
 * which is why it rides the locked `app.substrate` too — with the shell up and
 * `app.settings` off this file correctly renders nothing (the root slot is not
 * empty), and the manager's page has to be the thing that survives. Neither half
 * is reachable by locking a *contribution*: reachability is a property of what
 * renders, which is what that move fixes.
 *
 * **What is still open, and it is the design's rather than a gap here:** a
 * plugin-contributed `ui.root.layout` that renders no `settings.root` shows the
 * manager nowhere — the plugin owns the UI at that point. Worth stating because
 * a reader who takes "the manager is always reachable" as unconditional would
 * otherwise trust a claim the code does not make.
 */

/** What the container renders in place of a layout: the route, and what is off. */
export interface MinimalHostView {
	/** True when nothing visible is in `ui.root.layout`, so the surface is shown. */
	readonly engaged: boolean;
	/** The labels of the areas the resolved flags record off, in table order. */
	readonly offLabels: readonly string[];
	/** The way back: the manager's own component. */
	readonly route: ComponentType;
}

/**
 * The pure view-model (`builtinRows`'s shape), so the container's decision and
 * its route are values a test drives; the assertions that need the real
 * registries live in `state/builtins.test.ts` beside the invariant.
 *
 * The off-rule is `!== true` — the same question `areaEnabled` answers, so the
 * container and the reconcile cannot disagree about what is on. It reads the
 * store's **resolved** map (one entry per identity, `state/builtins.ts`), where
 * the strict form and an absent-means-on form agree on every value it can
 * carry; `MinimalHost.test.ts` pins the strict reading of a partial map, as
 * `areaEnabled`'s own test does.
 */
export const minimalHostView = (
	rootEntries: readonly Contribution[],
	builtins: Readonly<Record<string, boolean>>,
): MinimalHostView => ({
	engaged: rootEntries.length === 0,
	offLabels: BUILTIN_IDENTITIES.filter(
		(identity) => builtins[identity.id] !== true,
	).map((identity) => identity.label),
	route: PluginsSection,
});

/**
 * The one line naming what is off. The empty case is real — a plugin can hide
 * or dispose a layout without any area being recorded off — and it must not
 * then claim there is something to turn back on.
 */
export const offLine = (labels: readonly string[]): string =>
	labels.length === 0
		? "Nothing is recorded off; the layout slot simply has no visible contribution."
		: `Off right now: ${labels.join(", ")}.`;

/** The route back to the manager, rendered only when no layout is present. */
export function MinimalHost() {
	const entries = useContribution("ui.root.layout");
	const snapshot = useBuiltins();
	const view = minimalHostView(entries, snapshot.builtins);
	if (!view.engaged) return null;
	const Route = view.route;

	return (
		<div className="flex h-full w-full justify-center overflow-y-auto bg-neutral-950 px-4 py-6 text-left">
			<div className="flex w-full max-w-2xl flex-col gap-3">
				<p className="text-sm text-neutral-100">
					Nothing is rendering the app&apos;s layout right now, so the container
					is showing this minimal host surface instead.
				</p>
				<p className="text-xs text-neutral-500">{offLine(view.offLabels)}</p>
				<Route />
			</div>
		</div>
	);
}
