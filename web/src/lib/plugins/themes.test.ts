import { describe, expect, test } from "bun:test";
import { registerThemeBuiltins } from "@lib/plugins/builtin/themes";
import { darkTheme } from "@lib/plugins/builtin/themes/dark";
import {
	type Host,
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { RegistryEntry } from "@lib/plugins/registry";
import {
	makeThemeService,
	type ThemeContribution,
	type ThemeDefinition,
	type ThemeDom,
} from "@lib/plugins/themes";
import { Effect, Fiber, Logger, Option, Scope } from "effect";

/**
 * The theme service against a recorded DOM seam. bun's test environment has no
 * DOM, so the seam the service reads and writes is a small object (spec §4's
 * "variables + an injected stylesheet" made observable): the real element path
 * is one adapter (`browserThemeDom`) and is proven in the browser, while the
 * rules — every variable applied, one stylesheet replaced not stacked, defaults
 * restored on unregister — are asserted here.
 *
 * The registry is the real one (`HostLayer`), never a fake: registering through
 * it is what makes the built-in collision and the stream reconcile meaningful.
 */

/** What the fake seam records, plus the counters a replacement test needs. */
interface FakeDom extends ThemeDom {
	readonly variables: Map<string, string>;
	/** The one stylesheet slot the seam owns; a second write replaces it. */
	readonly css: { value: string | undefined };
	readonly cssWrites: { count: number };
	/** The id the service marked active on the root, or undefined. */
	readonly activeId: { value: string | undefined };
}

const fakeDom = (): FakeDom => {
	const variables = new Map<string, string>();
	const css: { value: string | undefined } = { value: undefined };
	const cssWrites = { count: 0 };
	const activeId: { value: string | undefined } = { value: undefined };
	return {
		variables,
		css,
		cssWrites,
		activeId,
		setVariable: (name, value) => {
			variables.set(name, value);
		},
		removeVariable: (name) => {
			variables.delete(name);
		},
		setStyleSheet: (value) => {
			cssWrites.count += 1;
			css.value = value;
		},
		setActiveId: (id) => {
			activeId.value = id;
		},
	};
};

const registries = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const hostFor = (services: HostServicesShape, id = "plugins.test"): Host =>
	makeHost(services, id, Effect.runSync(Scope.make()));

/**
 * A host over the app's services, but with the one theme core writing to the
 * recorded DOM. The host surface reads the core from the services shape, never
 * building one, so this is exactly the app's wiring with an observable seam.
 */
const hostWithDom = (services: HostServicesShape, dom: ThemeDom): Host =>
	hostFor({
		...services,
		themesService: makeThemeService(services.themes, dom),
	});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect);

/** A logger that swallows output, so an expected warning stays out of the run. */
const silent = Logger.layer([Logger.make(() => {})]);

describe("makeThemeService", () => {
	test("applying a theme sets every variable and injects its CSS", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = hostWithDom(services, dom).themes;

		themes.register({
			id: "test.theme.a",
			name: "A",
			variables: { "--x": "1", "--y": "2" },
			css: ":root{--x:1}",
		});
		await run(themes.apply("test.theme.a"));

		expect([...dom.variables]).toEqual([
			["--x", "1"],
			["--y", "2"],
		]);
		expect(dom.css.value).toBe(":root{--x:1}");
		expect(dom.cssWrites.count).toBe(1);
		expect(dom.activeId.value).toBe("test.theme.a");
		expect(Option.getOrNull(await run(themes.active()))).toBe("test.theme.a");
	});

	test("applying a second theme replaces the first rather than stacking", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = hostWithDom(services, dom).themes;

		themes.register({
			id: "test.theme.a",
			name: "A",
			variables: { "--shared": "old", "--only-a": "1" },
			css: "a",
		});
		themes.register({
			id: "test.theme.b",
			name: "B",
			variables: { "--shared": "new", "--only-b": "2" },
			css: "b",
		});

		await run(themes.apply("test.theme.a"));
		await run(themes.apply("test.theme.b"));

		// The first theme's private key is gone, the shared key is the second's,
		// and the seam holds one stylesheet — the second, not both.
		expect([...dom.variables]).toEqual([
			["--shared", "new"],
			["--only-b", "2"],
		]);
		expect(dom.css.value).toBe("b");
		expect(dom.activeId.value).toBe("test.theme.b");
	});

	test("unregistering the active theme restores the defaults", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = hostWithDom(services, dom).themes;

		const handle = themes.register({
			id: "test.theme.a",
			name: "A",
			variables: { "--x": "1" },
			css: ":root{--x:1}",
		});
		await run(themes.apply("test.theme.a"));
		expect(dom.variables.size).toBe(1);

		handle.dispose();

		expect(dom.variables.size).toBe(0);
		expect(dom.css.value).toBeUndefined();
		expect(dom.activeId.value).toBeUndefined();
		expect(Option.isNone(await run(themes.active()))).toBe(true);
	});

	test("a theme may define variables the app never named", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = hostWithDom(services, dom).themes;

		themes.register({
			id: "test.theme.new",
			name: "New",
			variables: { "--plugin-accent": "#ff00ff" },
		});
		await run(themes.apply("test.theme.new"));

		expect(dom.variables.get("--plugin-accent")).toBe("#ff00ff");
		expect(dom.css.value).toBeUndefined();
	});

	test("applying an unknown id leaves the defaults and does not fail", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = hostWithDom(services, dom).themes;

		await run(Effect.provide(themes.apply("test.theme.missing"), silent));

		expect(dom.variables.size).toBe(0);
		expect(dom.css.value).toBeUndefined();
		expect(Option.isNone(await run(themes.active()))).toBe(true);
	});

	test("a theme id colliding with the built-in replaces it in place", async () => {
		const services = registries();
		const dom = fakeDom();
		// One core (the app's), two plugins' views of it.
		const withCore: HostServicesShape = {
			...services,
			themesService: makeThemeService(services.themes, dom),
		};
		const builtinHost = hostFor(withCore, "app.builtin");
		const pluginHost = hostFor(withCore, "acme.theme");

		// The shipping theme, then a plugin theme claiming the same id.
		builtinHost.themes.register(darkTheme);
		pluginHost.themes.register({
			...darkTheme,
			name: "Acme dark",
			variables: { "--collide": "1" },
		});

		const entries = await run(services.themes.entries());
		const dark = entries.filter((entry) => entry.id === darkTheme.id);
		expect(dark.length).toBe(1);
		expect(dark[0]?.owner).toBe("acme.theme");
		expect((dark[0] as ThemeContribution).name).toBe("Acme dark");

		// Applying the collided id applies the plugin's theme, not the built-in's,
		// through the one shared core.
		await run(pluginHost.themes.apply(darkTheme.id));
		expect([...dom.variables]).toEqual([["--collide", "1"]]);
	});

	test("the registry stream restores the defaults when the active theme is unregistered out of band", async () => {
		await run(
			Effect.gen(function* () {
				const services = registries();
				const dom = fakeDom();
				const themes = hostWithDom(services, dom).themes;

				// Registered raw, so its disposal carries no restore of its own: only
				// the stream can notice, which is the plugin-unload (scope-close) path.
				const definition: ThemeDefinition = {
					id: "test.theme.raw",
					name: "Raw",
					variables: { "--r": "1" },
				};
				const raw: { dispose: () => void } = themes.register(definition);

				const fiber = yield* themes.run().pipe(Effect.forkChild);
				yield* themes.apply("test.theme.raw");
				expect(dom.variables.get("--r")).toBe("1");

				yield* Effect.sync(() => raw.dispose());
				for (let tick = 0; tick < 20 && dom.variables.size > 0; tick += 1) {
					yield* Effect.yieldNow;
				}

				expect(dom.variables.size).toBe(0);
				expect(dom.css.value).toBeUndefined();
				expect(Option.isNone(yield* themes.active())).toBe(true);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});
});

describe("registerThemeBuiltins", () => {
	test("registers the shipping dark theme through the host", async () => {
		const services = registries();
		const host = hostFor(services, "app.builtin");
		registerThemeBuiltins(host);

		const entries: readonly RegistryEntry[] = await run(
			services.themes.entries(),
		);
		expect(entries.map((entry) => entry.id)).toEqual([darkTheme.id]);
		expect(entries[0]?.owner).toBe("app.builtin");
	});

	test("every dark-theme value is a CSS custom property", () => {
		for (const name of Object.keys(darkTheme.variables)) {
			expect(name.startsWith("--")).toBe(true);
		}
	});
});

/**
 * The reachability contract Task 19's acceptance run found missing: `apply`
 * must be on the host surface, and applying through a plugin's host must reach
 * the **one** service the app itself uses — one `<style>` element, one
 * `data-theme` marker — not a second instance the plugin quietly builds.
 *
 * The recorded DOM seam is injected into the service the services shape
 * carries, so the test observes exactly what the app's built-in would.
 */
describe("host.themes (the service on the host surface)", () => {
	test("exposes apply/active/clear, and a plugin reaches the app's one core", async () => {
		const services = registries();
		const dom = fakeDom();
		// The shape the app runs with, but with a recorded DOM so the assertions
		// can see the writes the real document would receive.
		const withCore: HostServicesShape = {
			...services,
			themesService: makeThemeService(services.themes, dom),
		};
		const builtin = makeHost(
			withCore,
			"app.builtin",
			Effect.runSync(Scope.make()),
		);
		const plugin = makeHost(
			withCore,
			"acme.theme",
			Effect.runSync(Scope.make()),
		);

		// Reachable through the host surface — the hole this task closes.
		expect(typeof plugin.themes.apply).toBe("function");
		expect(typeof plugin.themes.active).toBe("function");
		expect(typeof plugin.themes.clear).toBe("function");

		const handle = plugin.themes.register({
			id: "acme.theme.t",
			name: "T",
			variables: { "--acme": "1" },
			css: "body{color:red}",
		});
		await run(plugin.themes.apply("acme.theme.t"));

		// The plugin's apply wrote the service's own DOM: its variables, its one
		// stylesheet, its marker — not the plugin's own <style> element.
		expect(dom.variables.get("--acme")).toBe("1");
		expect(dom.css.value).toBe("body{color:red}");
		expect(dom.cssWrites.count).toBe(1);
		expect(dom.activeId.value).toBe("acme.theme.t");

		// Same instance the built-in sees: the built-in's view reports the
		// plugin's apply, which only a shared core can do.
		expect(Option.getOrNull(await run(builtin.themes.active()))).toBe(
			"acme.theme.t",
		);

		// `clear` is the inverse, through the same core.
		await run(plugin.themes.clear());
		expect(dom.variables.size).toBe(0);
		expect(dom.css.value).toBeUndefined();
		expect(dom.activeId.value).toBeUndefined();
		expect(Option.isNone(await run(builtin.themes.active()))).toBe(true);

		handle.dispose();
	});

	test("the built-in and a plugin register and apply through one core", async () => {
		const services = registries();
		const dom = fakeDom();
		const withCore: HostServicesShape = {
			...services,
			themesService: makeThemeService(services.themes, dom),
		};
		const builtin = makeHost(
			withCore,
			"app.builtin",
			Effect.runSync(Scope.make()),
		);
		const plugin = makeHost(
			withCore,
			"acme.theme",
			Effect.runSync(Scope.make()),
		);

		registerThemeBuiltins(builtin);
		plugin.themes.register({
			id: "acme.theme.t",
			name: "T",
			variables: { "--x": "1" },
		});

		// The built-in's dark theme, applied through the plugin's host surface,
		// is indistinguishable from the built-in applying it: one core, one DOM.
		await run(plugin.themes.apply(darkTheme.id));
		expect(dom.activeId.value).toBe(darkTheme.id);
		expect(Option.getOrNull(await run(builtin.themes.active()))).toBe(
			darkTheme.id,
		);
	});
});
