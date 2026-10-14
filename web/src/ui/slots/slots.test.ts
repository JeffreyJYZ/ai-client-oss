import { describe, expect, test } from "bun:test";
import type { Contribution } from "@lib/plugins/host";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContributionBoundary } from "@/ui/slots/ContributionBoundary";
import { resolveComponent } from "@/ui/slots/useContribution";

/**
 * The two `useComponent`/`Slot` behaviours that carry failure isolation and
 * override resolution. Neither hook can be rendered here (no DOM in the test
 * runner), so the resolution rule is exercised through the pure
 * `resolveComponent` the hook delegates to, and the boundary through its own
 * state machine plus a real `renderToStaticMarkup` of the fallback. The full
 * DOM proof is Task 6's browser proof.
 */

type AnyComponent = ComponentType<Record<string, unknown>>;

const component = (label: string): AnyComponent => {
	const Component = (): ReactNode => label;
	return Component;
};

const builtin = component("builtin");
const override = component("override");

const entry = (id: string, over: Partial<Contribution> = {}): Contribution => ({
	id,
	owner: "acme",
	slot: "chat.message",
	component: builtin,
	...over,
});

describe("resolveComponent", () => {
	test("resolves the built-in registered at ui.<componentId>", () => {
		const entries = [entry("ui.message")];
		expect(resolveComponent(entries, "ui.message")).toBe(builtin);
		// The `ui.` prefix is optional: either half of the registered name works.
		expect(resolveComponent(entries, "message")).toBe(builtin);
	});

	test("an override outranks the built-in, and hidden still falls back", () => {
		const entries = [
			entry("ui.message"),
			entry("message", { component: override, priority: 5 }),
		];
		expect(resolveComponent(entries, "ui.message")).toBe(override);

		// Hiding the override leaves the built-in visible (spec §4: hide keeps
		// the contribution registered, it just stops rendering).
		const hidden = [
			entry("ui.message"),
			entry("message", { component: override, priority: 5, hidden: true }),
		];
		expect(resolveComponent(hidden, "ui.message")).toBe(builtin);
	});

	test("an unregistered id resolves to nothing (the hook renders empty)", () => {
		expect(resolveComponent([entry("ui.message")], "ui.markdown")).toBe(
			undefined,
		);
	});
});

describe("ContributionBoundary", () => {
	test("turns a fault into a one-line notice naming the owner", () => {
		// React calls this static hook when a child throws during render; the
		// boundary's own machine is what the rest of the test drives.
		expect(ContributionBoundary.getDerivedStateFromError()).toEqual({
			failed: true,
		});

		const boundary = new ContributionBoundary({
			owner: "acme",
			children: null,
		});
		// Before any fault it renders its children untouched.
		expect(boundary.render()).toBeNull();

		boundary.state = { failed: true };
		const html = renderToStaticMarkup(boundary.render());
		// Neutral about the owner: it is a plugin id here, but a built-in area
		// id for a built-in contribution, and this boundary cannot tell them
		// apart (so it must not say "plugin").
		expect(html).toContain("acme failed to render");
		// It does not blank the page: the fallback is a real element, not null.
		expect(html.startsWith("<p")).toBe(true);
	});
});
