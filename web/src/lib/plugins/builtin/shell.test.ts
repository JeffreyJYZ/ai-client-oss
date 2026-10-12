import { describe, expect, test } from "bun:test";
import { registerShellBuiltins } from "@lib/plugins/builtin/shell";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import { Effect, Exit, Scope } from "effect";

/**
 * The shell's contribution set, asserted against the real registry — the
 * browser proof checks what it renders, this checks what the app registers.
 * Without it, the shell could silently stop filling a region (or start filling
 * one another task owns) and the DOM assertions in the browser proof would
 * still pass on whatever did render.
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

describe("registerShellBuiltins", () => {
	test("registers the shell's own regions and nothing else", () => {
		const services = registries();
		registerShellBuiltins(host(services));

		const slots = [
			...new Set(Effect.runSync(services.ui.entries()).map((e) => e.slot)),
		].sort();

		// The content regions (`chat.*`, `composer.*`, `settings.*`,
		// `app.sidebar*`) belong to Tasks 7–9 and must stay unfilled here.
		expect(slots).toEqual([
			"app.header.actions",
			"app.header.title",
			"app.notices",
			"ui.root.layout",
		]);
	});

	test("every region is filled in today's render order", () => {
		const services = registries();
		registerShellBuiltins(host(services));

		expect(idsFor(services, "app.header.actions")).toEqual([
			"shell.header.system-prompt",
			"shell.header.profile-picker",
			"shell.header.provider-picker",
			"shell.header.download",
			"shell.header.settings-toggle",
		]);
		expect(idsFor(services, "app.notices")).toEqual([
			"shell.notices.install-note",
			"shell.notices.update",
		]);
		expect(idsFor(services, "app.header.title")).toEqual([
			"shell.header.title",
		]);
		expect(idsFor(services, "ui.root.layout")).toEqual(["ui.root.layout"]);
	});

	test("every contribution is owned by the plugin whose host registered it", () => {
		const services = registries();
		registerShellBuiltins(host(services));

		const owned = Effect.runSync(services.ui.ownedBy("app.builtin"));
		const shell = Effect.runSync(services.ui.entries());
		expect(setOf(owned)).toEqual(setOf(shell));
		expect(Effect.runSync(services.ui.ownedBy("someone.else"))).toEqual([]);
	});

	test("closing the host's scope leaves no shell contribution behind", () => {
		const services = registries();
		const scope = Effect.runSync(Scope.make());
		registerShellBuiltins(makeHost(services, "app.builtin", scope));
		expect(idsFor(services, "app.header.actions")).toHaveLength(5);

		Effect.runSync(Scope.close(scope, Exit.void));
		expect(Effect.runSync(services.ui.entries())).toEqual([]);
	});
});

const setOf = (entries: readonly { readonly id: string }[]): string[] =>
	entries.map((entry) => entry.id).sort();
