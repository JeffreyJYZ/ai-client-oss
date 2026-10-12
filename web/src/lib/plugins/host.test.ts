import { describe, expect, spyOn, test } from "bun:test";
import { PluginFault } from "@lib/plugins/errors";
import {
	type Host,
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
	pluginApiVersion,
} from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import appPackage from "@root/package.json";
import { Effect, Exit, Scope } from "effect";
import type { ComponentType } from "react";

/**
 * The registries the layer builds. A fresh set per test: registrations are the
 * subject, so a shared `HostServices` would leak entries between tests.
 */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const component = (): ComponentType<Record<string, unknown>> => () => null;

const contribution = (id: string, slot: SlotId = "app.header") => ({
	id,
	slot,
	component: component(),
});

const ids = (entries: readonly { readonly id: string }[]): string[] =>
	entries.map((entry) => entry.id);

describe("makeHost", () => {
	test("refuses an unknown slot id with a logged PluginFault instead of throwing", () => {
		const registries = services();
		const host = makeHost(registries, "p1", scope());

		const logged = spyOn(console, "log");
		let handle: { dispose: () => void } | undefined;
		expect(() => {
			handle = host.ui.register({
				id: "bad",
				// The type says `SlotId`, but a plugin is untyped JavaScript at
				// this boundary; the host must validate the value it is handed.
				slot: "not.a.slot" as unknown as SlotId,
				component: component(),
			});
		}).not.toThrow();
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		const faults = calls.filter((value) => value instanceof PluginFault);
		expect(faults).toHaveLength(1);
		expect((faults[0] as PluginFault).pluginId).toBe("p1");
		expect((faults[0] as PluginFault).detail).toContain("not.a.slot");
		// The refused contribution is not registered, and its handle is inert.
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
		expect(() => handle?.dispose()).not.toThrow();
	});

	test("every register returns a Disposable that removes exactly its entry", () => {
		const registries = services();
		const host = makeHost(registries, "p1", scope());

		const first = host.ui.register(contribution("a"));
		host.ui.register(contribution("b"));
		expect(ids(Effect.runSync(registries.ui.entries()))).toEqual(["a", "b"]);

		first.dispose();
		expect(ids(Effect.runSync(registries.ui.entries()))).toEqual(["b"]);
		// Idempotent: a second dispose removes nothing.
		first.dispose();
		expect(ids(Effect.runSync(registries.ui.entries()))).toEqual(["b"]);
	});

	test("each registry kind accepts a registration and disposes it", () => {
		const registries = services();
		const host = makeHost(registries, "p1", scope());

		const handles = [
			host.ui.register(contribution("u")),
			host.commands.register({ id: "cmd" }),
			host.settings.register({ id: "section" }),
			host.tools.register({ id: "tool" }),
			host.providers.register({ id: "provider" }),
			host.pipeline.register({ id: "stage" }),
			host.renderers.register({ id: "renderer" }),
			host.themes.register({ id: "theme" }),
		];

		expect(ids(Effect.runSync(registries.tools.ownedBy("p1")))).toEqual([
			"tool",
		]);
		// Every entry is owned by the plugin the host was built for.
		expect(ids(Effect.runSync(registries.themes.ownedBy("p1")))).toEqual([
			"theme",
		]);

		for (const handle of handles) handle.dispose();
		expect(Effect.runSync(registries.commands.entries())).toEqual([]);
		expect(Effect.runSync(registries.pipeline.entries())).toEqual([]);
		expect(Effect.runSync(registries.renderers.entries())).toEqual([]);
		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
	});

	test("closing a plugin's scope removes that plugin's registrations and leaves another plugin's", () => {
		const registries = services();
		const scopeA = scope();
		const scopeB = scope();
		const hostA = makeHost(registries, "p-a", scopeA);
		const hostB = makeHost(registries, "p-b", scopeB);

		hostA.ui.register(contribution("a1"));
		hostA.tools.register({ id: "tool-a" });
		hostB.ui.register(contribution("b1"));

		expect(ids(Effect.runSync(registries.ui.entries()))).toEqual(["a1", "b1"]);

		Effect.runSync(Scope.close(scopeA, Exit.void));

		expect(ids(Effect.runSync(registries.ui.entries()))).toEqual(["b1"]);
		expect(Effect.runSync(registries.ui.ownedBy("p-a"))).toEqual([]);
		expect(Effect.runSync(registries.tools.entries())).toEqual([]);
		// The other plugin's registration is untouched.
		expect(ids(Effect.runSync(registries.ui.ownedBy("p-b")))).toEqual(["b1"]);
	});

	test("registering on an already-closed scope leaves no trace", () => {
		const registries = services();
		const closed = scope();
		Effect.runSync(Scope.close(closed, Exit.void));

		const host = makeHost(registries, "p1", closed);
		host.ui.register(contribution("late"));
		host.tools.register({ id: "late-tool" });

		expect(Effect.runSync(registries.ui.entries())).toEqual([]);
		expect(Effect.runSync(registries.tools.entries())).toEqual([]);
	});

	test("carries the plugin API version and one distinct registry per kind", () => {
		const registries = services();
		const host: Host = makeHost(registries, "p1", scope());

		expect(host.version.api).toBe(pluginApiVersion);
		expect(
			Object.keys(registries)
				.filter((key) => key !== "version")
				.sort(),
		).toEqual([
			"commands",
			"keybindings",
			"pipeline",
			"providers",
			"renderers",
			"settings",
			"themes",
			"tools",
			"ui",
		]);
		expect(registries.ui).not.toBe(registries.tools);
		expect(registries.commands).not.toBe(registries.keybindings);
	});

	test("reports the build's real, non-empty app version", () => {
		const registries = services();
		const host = makeHost(registries, "p1", scope());

		// This run has no Tauri shell (`isDesktop` is false), so it exercises
		// the web path: the app version must be the real one from
		// `package.json`, never a placeholder like `""`.
		expect(host.version.app).not.toBe("");
		expect(host.version.app).toBe(appPackage.version);
	});

	test("takes the app version from the service, not a constant in makeHost", () => {
		const registries = services();
		const host = makeHost(
			{ ...registries, version: { app: "9.9.9", api: "0.1" } },
			"p1",
			scope(),
		);

		expect(host.version).toEqual({ app: "9.9.9", api: "0.1" });
	});
});
