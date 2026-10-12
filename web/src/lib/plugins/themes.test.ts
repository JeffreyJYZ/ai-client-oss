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

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect);

/** A logger that swallows output, so an expected warning stays out of the run. */
const silent = Logger.layer([Logger.make(() => {})]);

describe("makeThemeService", () => {
	test("applying a theme sets every variable and injects its CSS", async () => {
		const services = registries();
		const dom = fakeDom();
		const themes = makeThemeService(hostFor(services).themes, dom);

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
		const themes = makeThemeService(hostFor(services).themes, dom);

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
		const themes = makeThemeService(hostFor(services).themes, dom);

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
		const themes = makeThemeService(hostFor(services).themes, dom);

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
		const themes = makeThemeService(hostFor(services).themes, dom);

		await run(Effect.provide(themes.apply("test.theme.missing"), silent));

		expect(dom.variables.size).toBe(0);
		expect(dom.css.value).toBeUndefined();
		expect(Option.isNone(await run(themes.active()))).toBe(true);
	});

	test("a theme id colliding with the built-in replaces it in place", async () => {
		const services = registries();
		const builtinHost = hostFor(services, "app.builtin");
		const pluginHost = hostFor(services, "acme.theme");
		const dom = fakeDom();

		// The shipping theme, then a plugin theme claiming the same id.
		makeThemeService(builtinHost.themes, dom).register(darkTheme);
		const plugin = makeThemeService(pluginHost.themes, dom);
		plugin.register({
			...darkTheme,
			name: "Acme dark",
			variables: { "--collide": "1" },
		});

		const entries = await run(services.themes.entries());
		const dark = entries.filter((entry) => entry.id === darkTheme.id);
		expect(dark.length).toBe(1);
		expect(dark[0]?.owner).toBe("acme.theme");
		expect((dark[0] as ThemeContribution).name).toBe("Acme dark");

		// Applying the collided id applies the plugin's theme, not the built-in's.
		await run(plugin.apply(darkTheme.id));
		expect([...dom.variables]).toEqual([["--collide", "1"]]);
	});

	test("the registry stream restores the defaults when the active theme is unregistered out of band", async () => {
		await run(
			Effect.gen(function* () {
				const services = registries();
				const dom = fakeDom();
				const host = hostFor(services);
				const themes = makeThemeService(host.themes, dom);

				// Registered raw, so its disposal carries no restore of its own: only
				// the stream can notice, which is the plugin-unload (scope-close) path.
				const definition: ThemeDefinition = {
					id: "test.theme.raw",
					name: "Raw",
					variables: { "--r": "1" },
				};
				const raw: { dispose: () => void } = host.themes.register(definition);

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
