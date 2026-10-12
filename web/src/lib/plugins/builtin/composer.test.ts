import { describe, expect, test } from "bun:test";
import { registerComposerBuiltins } from "@lib/plugins/builtin/composer";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import { Effect, Exit, Scope } from "effect";

/**
 * The composer's contribution set, asserted against the real registry. The
 * browser proof checks what the composer renders and does; this checks what the
 * app registers, so a region cannot silently stop being filled (or start
 * filling one another task owns) without a test noticing.
 */

const registries = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const host = (services: HostServicesShape) =>
	makeHost(services, "app.builtin", Effect.runSync(Scope.make()));

/** The ids registered to `slot`, in resolution order. */
const idsFor = (services: HostServicesShape, slot: SlotId): string[] =>
	Effect.runSync(services.ui.entries())
		.filter((entry) => entry.slot === slot)
		.map((entry) => entry.id);

describe("registerComposerBuiltins", () => {
	test("fills only the composer's own regions", () => {
		const services = registries();
		registerComposerBuiltins(host(services));

		const slots = [
			...new Set(Effect.runSync(services.ui.entries()).map((e) => e.slot)),
		].sort();

		// Every other region belongs to a sibling task and must stay unfilled.
		expect(slots).toEqual([
			"composer.actions",
			"composer.root",
			"composer.toolbar",
		]);
	});

	test("fills each region in today's render order", () => {
		const services = registries();
		registerComposerBuiltins(host(services));

		// The composer is the root region's default, registered under the
		// `ui.composer` component id so `useComponent`/an override can resolve it.
		expect(idsFor(services, "composer.root")).toEqual(["ui.composer"]);
		// The input+attach button, then the textarea, then the chip entry — which
		// is resolved per chip by the composer and renders nothing at the slot.
		expect(idsFor(services, "composer.toolbar")).toEqual([
			"composer.toolbar.attach",
			"composer.toolbar.textarea",
			"ui.attachment-chip",
		]);
		expect(idsFor(services, "composer.actions")).toEqual([
			"composer.actions.stop",
			"composer.actions.send",
		]);
	});

	test("every contribution is owned by the built-in plugin", () => {
		const services = registries();
		registerComposerBuiltins(host(services));

		const owned = Effect.runSync(services.ui.ownedBy("app.builtin"));
		const all = Effect.runSync(services.ui.entries());
		expect(owned).toHaveLength(all.length);
		expect(Effect.runSync(services.ui.ownedBy("someone.else"))).toEqual([]);
	});

	test("closing the host's scope leaves no composer contribution behind", () => {
		const services = registries();
		const scope = Effect.runSync(Scope.make());
		registerComposerBuiltins(makeHost(services, "app.builtin", scope));
		expect(idsFor(services, "composer.root")).toHaveLength(1);

		Effect.runSync(Scope.close(scope, Exit.void));
		expect(Effect.runSync(services.ui.entries())).toEqual([]);
	});
});
