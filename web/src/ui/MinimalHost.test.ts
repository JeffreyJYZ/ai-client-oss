import { describe, expect, test } from "bun:test";
import { BUILTIN_IDENTITIES } from "@lib/plugins/builtinIdentity";
import type { Contribution } from "@lib/plugins/host";
import { minimalHostView, offLine } from "@/ui/MinimalHost";
import { PluginsSection } from "@/ui/plugins/PluginsSection";

/**
 * The container's minimal host surface — the recovery half of the finding that
 * the locked set guarantees an entry stays **registered**, not that it is
 * **reachable**: `app.shell` owns the only `ui.root.layout`, so with it off the
 * container used to render a blank page and the Plugins manager had no route
 * back to it.
 *
 * The surface is a value in / value out view-model (`builtinRows`'s shape),
 * driven here directly. The one assertion a value cannot make on its own — that
 * the registry's root layout slot is genuinely empty in the state the surface
 * exists for — is made against the **real registries** in
 * `state/builtins.test.ts`, next to the invariant that state belongs to.
 */

/** The store's resolved map: every identity present, `off` recorded `false`. */
const flags = (off: readonly string[] = []): Record<string, boolean> =>
	Object.fromEntries(
		BUILTIN_IDENTITIES.map((identity) => [
			identity.id,
			!off.includes(identity.id),
		]),
	);

/** One live layout contribution, as the registry holds it. */
const layout = (id: string): Contribution => ({
	id,
	owner: "app.shell",
	slot: "ui.root.layout",
	component: () => null,
});

/** The ids of the areas that can be turned off, in table order. */
const toggleable = BUILTIN_IDENTITIES.filter(
	(identity) => identity.locked !== true,
);

describe("minimalHostView", () => {
	test("with nothing in the root layout slot the surface is engaged", () => {
		expect(minimalHostView([], flags()).engaged).toBe(true);
	});

	test("a live layout keeps the surface out of the page", () => {
		// The container renders the slot's own contribution and nothing else: the
		// surface must never become a second layout beside the shell (which is
		// also what keeps the DOM identical to the pre-plugin-system one).
		expect(minimalHostView([layout("ui.root.layout")], flags()).engaged).toBe(
			false,
		);
	});

	test("the route back is the manager's own component, by identity", () => {
		// The reachable target, not "something rendered": identity with the very
		// component the manager's registered entry carries
		// (`settings.section.plugins`). A second, recovery-only component would
		// pass a "renders something" test and still be a second manager.
		expect(minimalHostView([], flags()).route).toBe(PluginsSection);
	});

	test("it names exactly the areas the resolved flags record off", () => {
		const labels = (off: readonly string[]): readonly string[] =>
			minimalHostView([], flags(off)).offLabels;

		// Everything on: nothing to name.
		expect(labels([])).toEqual([]);
		// One area: exactly that one.
		expect(labels(["app.shell"])).toEqual(["Shell"]);
		// The bare preset: every non-locked area in table order, and no locked one
		// among them.
		expect(labels(toggleable.map((identity) => identity.id))).toEqual(
			toggleable.map((identity) => identity.label),
		);
	});

	test("a partial flags map reads an absent id as off, exactly as the reconciler's rule does", () => {
		// `areaEnabled` answers "is the resolved flag on?" with `=== true`, and
		// this mirrors it so the container and the reconcile cannot disagree about
		// what is on. The app cannot hand it a partial map (the store fills every
		// identity), so the input is pinned here rather than exercised in place —
		// the same pin `areaEnabled`'s own test carries.
		const partial = { "app.shell": true };
		expect(minimalHostView([], partial).offLabels).not.toContain("Shell");
		expect(minimalHostView([], partial).offLabels).toContain("Composer");
	});
});

describe("offLine", () => {
	test("names what is off, and claims nothing when nothing is", () => {
		expect(offLine(["Shell", "Settings"])).toBe(
			"Off right now: Shell, Settings.",
		);
		// The degeneration a hidden or plugin-owned layout produces: the slot is
		// empty while nothing is recorded off, and the line must not then claim
		// there is something to turn back on.
		expect(offLine([])).not.toContain("Off right now");
		expect(offLine([]).length).toBeGreaterThan(0);
	});
});
