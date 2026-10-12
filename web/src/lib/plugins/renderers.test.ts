import { describe, expect, test } from "bun:test";
import type { Contribution, Disposable, Host } from "@lib/plugins/host";
import { makeRendererRegistry, registerRenderer } from "@lib/plugins/renderers";
import type { ComponentType } from "react";
import { resolveComponent } from "@/ui/slots/useContribution";

/**
 * The renderer-override contract (spec §5), driven through a recording fake
 * `Host` and the real `resolveComponent` the message renderers use. No project
 * module is mocked (R13): the fake is a plain object the registrar calls, and
 * the resolution is the shipped pure function.
 *
 * What matters here is the id/priority convention: an override must outrank the
 * built-in, and disposing it must leave the built-in resolvable (the bug the
 * header warns about, which registering at `ui.<kind>` would cause).
 */

type Registered = Omit<Contribution, "owner">;

const component = (label: string): ComponentType<Record<string, unknown>> => {
	const Component = (): string => label;
	return Component;
};

const builtin = component("builtin");
const override = component("override");

const record = (): {
	readonly entries: Registered[];
	readonly host: Host;
} => {
	const entries: Registered[] = [];
	const host = {
		ui: {
			register: (entry: Registered): Disposable => {
				entries.push(entry);
				return { dispose: () => {} };
			},
		},
	} as unknown as Host;
	return { entries, host };
};

const builtinEntry = (kind: string): Contribution => ({
	id: `ui.${kind}`,
	owner: "app.builtin",
	slot: "chat.message",
	component: builtin,
});

describe("registerRenderer", () => {
	test("an override registers at the bare kind, outranks the built-in and restores it when disposed", () => {
		const { entries, host } = record();
		registerRenderer(host, "markdown", override);

		expect(entries.map((entry) => entry.id)).toEqual(["markdown"]);
		expect(entries[0]?.slot).toBe("chat.message");
		expect(entries[0]?.priority).toBeGreaterThan(0);

		const withOverride: Contribution[] = [
			builtinEntry("markdown"),
			...(entries as Contribution[]),
		];
		expect(resolveComponent(withOverride, "ui.markdown")).toBe(override);
		// The built-in's own handle is untouched: dropping the override leaves it.
		expect(resolveComponent([builtinEntry("markdown")], "ui.markdown")).toBe(
			builtin,
		);
	});

	test("every kind the message renderers resolve is accepted", () => {
		const { entries, host } = record();
		for (const kind of [
			"message",
			"markdown",
			"marker",
			"reasoning",
		] as const) {
			registerRenderer(host, kind, override);
		}
		expect(entries.map((entry) => entry.id)).toEqual([
			"message",
			"markdown",
			"marker",
			"reasoning",
		]);
	});

	test("an unknown kind is refused, not registered", () => {
		const { entries, host } = record();
		registerRenderer(
			host,
			"not-a-renderer" as unknown as Parameters<typeof registerRenderer>[1],
			override,
		);
		expect(entries).toEqual([]);
	});

	test("makeRendererRegistry exposes the same registration as renderers.register", () => {
		const { entries, host } = record();
		makeRendererRegistry(host).register("reasoning", override);
		expect(entries.map((entry) => entry.id)).toEqual(["reasoning"]);
	});
});
