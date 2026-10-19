import { afterEach, describe, expect, test } from "bun:test";
import {
	emptyProviderConfig,
	type ProviderConfig,
	type Settings,
} from "@lib/db";
import { BUILTIN_AREAS } from "@lib/plugins/areas";
import { makeBuiltinsReconciler } from "@lib/plugins/builtin";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { TitlerOutcome } from "@lib/titlerStatus";
import { Effect, Exit, Scope } from "effect";
import { getSettings, setSettings } from "@/state/settings";
import { TitlerSection } from "@/ui/titler/TitlerSection";
import {
	AUTOMATIC_KEY,
	titlerOptionKey,
	titlerRows,
	titlerSelectionPatch,
} from "@/ui/titler/titlerRows";

/**
 * The Titler section's pure half — all three hint states, the picker's
 * contents, and the write it makes — plus the one claim that is about the
 * **registration** rather than a value: the row is owned by the `app.titler`
 * area, so switching the area off removes it (asserted, not described).
 *
 * The two halves that cannot be a value are deliberately elsewhere: the picker
 * write goes through the app's real settings store (`state/settings.ts`, the
 * same seam the Memory suite uses), and the ownership claim runs the **real**
 * reconciler over the real areas and the real registries.
 */

const createdReconcilers: ReturnType<typeof makeBuiltinsReconciler>[] = [];
const trackedReconciler = (
	deps: Parameters<typeof makeBuiltinsReconciler>[0],
): ReturnType<typeof makeBuiltinsReconciler> => {
	const r = makeBuiltinsReconciler(deps);
	createdReconcilers.push(r);
	return r;
};
afterEach(async () => {
	for (const r of createdReconcilers) {
		for (const area of r.live()) {
			await Effect.runPromise(
				Scope.close(area.scope, Exit.void).pipe(
					Effect.catchCause(() => Effect.void),
				),
			);
		}
	}
	createdReconcilers.length = 0;
});

const provider = (
	id: string,
	overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({
	...emptyProviderConfig(id),
	label: id,
	...overrides,
});

const rowsFor = (options: {
	readonly resolved?: { readonly providerId: string; readonly model: string };
	readonly providers?: readonly ProviderConfig[];
	readonly selection?: Settings["titler"];
	readonly status?: TitlerOutcome;
}) =>
	titlerRows({
		resolved: options.resolved,
		providers: options.providers ?? [],
		selection: options.selection,
		status: options.status,
	});

describe("the hint's three states", () => {
	test("a resolved model names the model, the provider, and where the message goes", () => {
		const rows = rowsFor({
			resolved: { providerId: "or", model: "openrouter/free" },
			providers: [
				provider("or", { label: "OpenRouter", models: ["openrouter/free"] }),
			],
		});

		expect(rows.state).toBe("resolved");
		// Which model — the whole point of the state.
		expect(rows.hint).toContain("openrouter/free");
		expect(rows.hint).toContain("OpenRouter");
		// The privacy sentence the spec asks for: the first message reaches the
		// titler's provider, which need not be the chat's.
		expect(rows.hint).toContain("may be a different one from your chat");
		expect(rows.hint).toContain("A rename is never overwritten.");
	});

	test("nothing resolving names Fetch models as the remedy", () => {
		// The state a provider with no key, no provider at all, or an **empty
		// cached list** lands in — the empty list is why "Fetch models" is the
		// remedy rather than a guessed id.
		const rows = rowsFor({
			resolved: undefined,
			providers: [provider("or", { label: "OpenRouter", models: [] })],
		});

		expect(rows.state).toBe("unresolved");
		expect(rows.hint).toContain("Fetch models");
		expect(rows.hint).toContain("empty cached model list");
		expect(rows.hint).toContain("A rename is never overwritten.");
	});

	test("a stale failure record with no resolvable model loses to the no-model hint", () => {
		// F4: `titlerStatus` is one unnamed slot with no timestamp and no
		// conversation id, so a record from an earlier attempt can outlive the
		// model that produced it. The hint must then read the **live** state from
		// `resolveTitlerModel` — no model resolves, so the remedy is "Fetch
		// models / pick one", never "the last attempt failed".
		const rows = rowsFor({
			resolved: undefined,
			providers: [provider("or", { label: "OpenRouter", models: [] })],
			status: {
				model: "openrouter/free",
				ok: false,
				reason: "the endpoint refused the request",
			},
		});

		expect(rows.state).toBe("unresolved");
		expect(rows.hint).toContain("Fetch models");
		expect(rows.hint).toContain("A rename is never overwritten.");
		// The stale reason must never leak into the no-model hint.
		expect(rows.hint).not.toContain("the endpoint refused the request");
		expect(rows.hint).not.toContain("failed");
	});

	test("resolved and then failed reads the status record and names its reason", () => {
		const rows = rowsFor({
			resolved: { providerId: "or", model: "openrouter/free" },
			providers: [
				provider("or", { label: "OpenRouter", models: ["openrouter/free"] }),
			],
			status: {
				model: "openrouter/free",
				ok: false,
				reason: "the endpoint refused the request",
			},
		});

		expect(rows.state).toBe("failed");
		expect(rows.hint).toContain("openrouter/free");
		// The reason is the record's own, so a dead id and a 401 read differently.
		expect(rows.hint).toContain("the endpoint refused the request");
		// The remedy is still on the row, and the guarantee is stated exactly.
		expect(rows.hint).toContain("Fetch models");
		expect(rows.hint).toContain("A rename is never overwritten.");
	});

	test("a successful last attempt is the resolved state, not the failed one", () => {
		const rows = rowsFor({
			resolved: { providerId: "or", model: "openrouter/free" },
			providers: [provider("or", { models: ["openrouter/free"] })],
			status: { model: "openrouter/free", ok: true, reason: "titled" },
		});

		expect(rows.state).toBe("resolved");
		expect(rows.hint).not.toContain("failed");
	});
});

describe("the picker's options", () => {
	test("every provider's cached models, labelled by the provider", () => {
		const rows = rowsFor({
			providers: [
				provider("or", {
					label: "OpenRouter",
					models: ["openrouter/free", "a-paid-one"],
				}),
				provider("oc", { label: "OpenCode", models: ["beam-free"] }),
				// A provider with an empty cached list offers nothing to pick:
				// that is exactly the state the unresolved hint sends the user to
				// fix with Fetch models.
				provider("empty", { label: "Fresh", models: [] }),
			],
		});

		expect(
			rows.options.map((option) => [option.providerId, option.model]),
		).toEqual([
			["or", "openrouter/free"],
			["or", "a-paid-one"],
			["oc", "beam-free"],
		]);
		expect(rows.options[0]?.label).toBe("OpenRouter · openrouter/free");
		expect(rows.options.every((option) => !option.saved)).toBe(true);
	});

	test("a saved choice is the selection, keyed; a partial one is Automatic", () => {
		const providers = [provider("or", { models: ["openrouter/free"] })];

		const saved = rowsFor({
			providers,
			selection: { providerId: "or", model: "a-paid-one" },
		});
		expect(saved.selection).toEqual({
			providerId: "or",
			model: "a-paid-one",
		});
		expect(saved.selectionKey).toBe(
			titlerOptionKey({ providerId: "or", model: "a-paid-one" }),
		);

		// Half a choice is not a choice: `Settings.titler`'s fields are both
		// optional, and the rule refuses an override missing either.
		for (const selection of [
			undefined,
			{},
			{ providerId: "or" },
			{ model: "a-paid-one" },
			{ providerId: "", model: "a-paid-one" },
			{ providerId: "or", model: "  " },
		]) {
			const rows = rowsFor({ providers, selection });
			expect(rows.selection).toBeUndefined();
			expect(rows.selectionKey).toBe(AUTOMATIC_KEY);
		}
	});

	test("a saved choice the cached list no longer carries is still offered", () => {
		const cached = [provider("or", { models: ["openrouter/free"] })];
		const gone = rowsFor({
			providers: cached,
			selection: { providerId: "or", model: "removed-model" },
		});

		// Shown, so the `<select>` does not render blank and look like a lost
		// choice — and marked, so the user can tell it is no longer cached.
		expect(gone.options[0]).toEqual({
			providerId: "or",
			model: "removed-model",
			label: "or · removed-model (not in the cached list)",
			saved: true,
		});
		expect(gone.selectionKey).toBe(
			titlerOptionKey({ providerId: "or", model: "removed-model" }),
		);

		// A choice that *is* cached is not duplicated.
		const kept = rowsFor({
			providers: cached,
			selection: { providerId: "or", model: "openrouter/free" },
		});
		expect(kept.options).toHaveLength(1);
		expect(kept.options[0]?.saved).toBe(false);
	});
});

describe("what the picker writes", () => {
	test("a choice land in Settings.titler, and Automatic clears both fields", () => {
		const before = getSettings().titler;
		try {
			// The component's own call, through the app's real settings store: the
			// patch is validated by `Settings` and read back off the module.
			setSettings(
				titlerSelectionPatch({ providerId: "or", model: "a-paid-one" }),
			);
			expect(getSettings().titler).toEqual({
				providerId: "or",
				model: "a-paid-one",
			});

			// Automatic is not an empty-string pair: the rule would read that as an
			// override that resolves to nothing instead of "use the rule".
			setSettings(titlerSelectionPatch(undefined));
			expect(getSettings().titler).toBeUndefined();
		} finally {
			setSettings({ titler: before });
		}
	});
});

/* ------------------------------------------------------------- the registration */

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

describe("the section is the area's own", () => {
	test("the row rides settings.sections while the area is on, and is gone while it is off", async () => {
		const service = services();
		let titlerOn = true;
		const reconciler = trackedReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => (areaId === "app.titler" ? titlerOn : true),
			contributionEnabledOf: () => true,
			makeHost,
		});

		const rows = () => Effect.runSync(service.ui.entries());
		const row = () =>
			rows().find((entry) => entry.id === "settings.section.titler");

		await Effect.runPromise(reconciler.reconcile(service));
		const section = row();
		expect(section?.slot).toBe("settings.sections");
		// Identity, not a wrapper: the section this file's module exports.
		expect(section?.component).toBe(TitlerSection);
		// Owned by the area — which is what makes the toggle below take it away.
		expect(
			Effect.runSync(service.ui.ownedBy("app.titler")).map((entry) => entry.id),
		).toEqual(["settings.section.titler"]);

		// The gate: switching the area off removes the row it explains, and
		// leaves the rest of the settings page standing.
		titlerOn = false;
		await Effect.runPromise(reconciler.reconcile(service));
		expect(row()).toBeUndefined();
		expect(rows().map((entry) => entry.id)).toContain(
			"settings.section.memory",
		);

		// And back on, so the absence above is the gate and not a registrar that
		// never runs.
		titlerOn = true;
		await Effect.runPromise(reconciler.reconcile(service));
		expect(row()?.id).toBe("settings.section.titler");
	});
});
