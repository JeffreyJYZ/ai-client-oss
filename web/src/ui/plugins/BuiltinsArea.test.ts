import { describe, expect, test } from "bun:test";
import { Settings, settingsDefaults } from "@lib/db";
import { BUILTIN_AREAS } from "@lib/plugins/areas";
import {
	areaEnabled,
	contributionEnabled,
	makeBuiltinsReconciler,
} from "@lib/plugins/builtin";
import {
	BUILTIN_IDENTITIES,
	type BuiltinId,
} from "@lib/plugins/builtinIdentity";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { Effect } from "effect";
import {
	type BuiltinsDeps,
	type BuiltinsSnapshot,
	getBuiltinsSnapshot,
	makeBuiltinsStore,
	startBuiltins,
} from "@/state/builtins";
import { BUILTIN_CONTRIBUTIONS, builtinRows } from "@/ui/plugins/BuiltinsArea";

/**
 * The Built-ins drill-down's **pure** half. The repo has no React renderer
 * harness and does not need one for this: `builtinRows(snapshot)` turns the
 * store's snapshot into rows, so every behaviour under test here is a value in
 * and a value out, driven directly.
 *
 * The assertions that cannot be made from a value alone are made against the
 * **real registries** at the bottom: the reconciler registers contributions
 * through `gateHost`, which keys on the registry entry's own `id`, so a catalog
 * carrying anything else is a switch that silently does nothing. That is the
 * "a wrong key is invisible to the suite" failure this file exists to make
 * visible — the view-model's catalog is checked against what the gate reads.
 */

/** A store over an injected settings seam (the `state/builtins.test.ts` shape). */
const makeStore = (initial: Settings = settingsDefaults()) => {
	let settings = initial;
	const listeners = new Set<() => void>();
	const deps: BuiltinsDeps = {
		readSettings: () => settings,
		writeSettings: (patch) => {
			const parsed = Settings.safeParse({ ...settings, ...patch });
			if (!parsed.success) return;
			settings = parsed.data;
			for (const listener of listeners) listener();
		},
		subscribeSettings: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const store = makeBuiltinsStore(deps);
	store.start();
	return store;
};

/** The store's own snapshot, resolved before `start()` — this file's input. */
const snapshot = (): BuiltinsSnapshot => getBuiltinsSnapshot();

/* -------------------------------------------------------------- the view-model */

describe("builtinRows", () => {
	test("every identity becomes a row, carrying its id, label and description", () => {
		const rows = builtinRows(snapshot());

		expect(rows.map((row) => row.id)).toEqual(
			BUILTIN_IDENTITIES.map((identity) => identity.id),
		);
		for (const identity of BUILTIN_IDENTITIES) {
			const row = rows.find((candidate) => candidate.id === identity.id);
			expect(row?.label).toBe(identity.label);
			// One user-facing sentence stating what disappears when it is off.
			expect(row?.description).toBe(identity.description);
		}
	});

	test("an area's row is enabled by default and follows the store", () => {
		const store = makeStore();
		expect(
			builtinRows(store.getBuiltinsSnapshot()).find((r) => r.id === "app.shell")
				?.enabled,
		).toBe(true);

		store.setBuiltinEnabled("app.shell", false);
		expect(
			builtinRows(store.getBuiltinsSnapshot()).find((r) => r.id === "app.shell")
				?.enabled,
		).toBe(false);
	});

	test("a locked area carries a lockedReason, an unlocked one does not", () => {
		const rows = builtinRows(snapshot());

		for (const identity of BUILTIN_IDENTITIES) {
			const row = rows.find((candidate) => candidate.id === identity.id);
			if (identity.locked === true) {
				expect(row?.lockedReason, `${identity.id} is locked`).toBeTruthy();
			} else {
				expect(
					row?.lockedReason,
					`${identity.id} is not locked`,
				).toBeUndefined();
			}
		}
	});

	test("a contribution of a locked area is listed and not toggleable, and says why", () => {
		const row = builtinRows(snapshot()).find(
			(candidate) => candidate.id === "app.builtins",
		);

		// The manager's own section is the live example: it is a contribution of
		// the locked area, so it must appear and it must refuse with a reason.
		const contribution = row?.contributions.find(
			(candidate) => candidate.id === "settings.section.plugins",
		);
		expect(contribution).toBeDefined();
		expect(contribution?.lockedReason).toBeTruthy();
	});

	test("a disabled area still lists its contributions, for re-enabling", () => {
		const store = makeStore();
		store.setBuiltinEnabled("app.tools", false);

		const row = builtinRows(store.getBuiltinsSnapshot()).find(
			(r) => r.id === "app.tools",
		);
		expect(row?.enabled).toBe(false);
		expect(row?.contributions.map((c) => c.id)).toEqual([
			"fetch_url",
			"web_search",
		]);
	});

	test("a contribution's key is the id the gate uses", () => {
		// The literal registry ids — a UI/command/provider/tool/theme/settings
		// entry's own `id` (a tool's wire name). A derived key (a slot id plus
		// something, a composite) would make the switch a no-op; these literals
		// are what pins the key to the gate.
		const rows = builtinRows(snapshot());
		const ids = (area: string): readonly string[] =>
			rows.find((row) => row.id === area)?.contributions.map((c) => c.id) ?? [];

		expect(ids("app.tools")).toEqual(["fetch_url", "web_search"]);
		expect(ids("app.builtins")).toEqual(["settings.section.plugins"]);
		expect(ids("app.themes")).toEqual(["app.theme.dark"]);
		expect(ids("app.providers")).toEqual([
			"anthropic",
			"responses",
			"chatcompletions",
		]);
		expect(ids("app.commands")).toContain("app.command.palette");
		expect(ids("app.shell")).toContain("shell.header.title");
		expect(ids("app.substrate")).toEqual([]);
	});

	test("a contribution's enabled state is read by the reconciler's rule", () => {
		// The view-model re-states the rule rather than importing
		// `@lib/plugins/builtin` (that module imports `areas.ts`, which imports
		// this section — importing it back would close a cycle). Pinned here
		// against the production helpers, so a drift fails.
		const snapshotWithState: BuiltinsSnapshot = {
			enabled: false,
			builtins: { ...snapshot().builtins, "app.tools": false },
			contributions: { "app.tools": { fetch_url: false } },
		};

		const rows = builtinRows(snapshotWithState);
		for (const row of rows) {
			expect(row.enabled).toBe(areaEnabled(snapshotWithState.builtins, row.id));
			for (const contribution of row.contributions) {
				expect(contribution.enabled).toBe(
					contributionEnabled(
						snapshotWithState.contributions,
						row.id,
						contribution.id,
					),
				);
			}
		}
	});
});

/* ------------------------------------------------- the drill-down's own behaviour */

describe("the drill-down's toggle path", () => {
	test("toggling a contribution flips exactly that entry, by the registry id", () => {
		const store = makeStore();
		const row = builtinRows(store.getBuiltinsSnapshot()).find(
			(r) => r.id === "app.tools",
		);
		const contribution = row?.contributions.find((c) => c.id === "fetch_url");
		expect(contribution).toBeDefined();

		// The exact path the component calls: the row's own area id and the
		// contribution's own id, straight through the store.
		store.setContributionEnabled(row?.id ?? "", contribution?.id ?? "", false);

		const recorded = store.getBuiltinsSnapshot().contributions["app.tools"];
		expect(recorded?.fetch_url).toBe(false);
		// The sibling is untouched — a contribution toggle never touches another.
		expect(recorded?.web_search).toBeUndefined();
		expect(
			builtinRows(store.getBuiltinsSnapshot())
				.find((r) => r.id === "app.tools")
				?.contributions.find((c) => c.id === "fetch_url")?.enabled,
		).toBe(false);
	});
});

/* --------------------------------------------- the catalog against the real gate */

/**
 * The catalog is what the drill-down keys on, and the gate keys on the registry
 * entry's own `id`. So the two must be the same list: this reconciles each area
 * alone through the **real** reconciler over the real registries and asserts
 * the area's registered ids equal the catalog's. A catalog id the gate never
 * sees, or a registered id the catalog forgets, fails here.
 */

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const idsOf = (
	entries: readonly { readonly id: string }[],
): readonly string[] => entries.map((entry) => entry.id);

/**
 * Every registry's ids, across all six registries the gate filters.
 *
 * `pipeline` is one of them: `gateHost` (`lib/plugins/builtin/index.ts`) gates
 * `host.pipeline` on the entry id exactly as it gates the other five, so an area
 * that registered a stage would have a toggle keyed the same way. No built-in
 * registers one today, which is why the loop below cannot go red on this
 * addition — it is here so a future area that does is not invisible to the one
 * check whose job is to catch that.
 */
const allIds = (service: HostServicesShape): readonly string[] => [
	...idsOf(Effect.runSync(service.ui.entries())),
	...idsOf(Effect.runSync(service.commands.entries())),
	...idsOf(Effect.runSync(service.tools.entries())),
	...idsOf(Effect.runSync(service.providers.entries())),
	...idsOf(Effect.runSync(service.themes.entries())),
	...idsOf(Effect.runSync(service.pipeline.entries())),
];

/** The catalog's ids for an area, keyed the way the record is. */
const catalogIds = (areaId: string): readonly string[] =>
	BUILTIN_CONTRIBUTIONS[areaId as BuiltinId];

describe("the catalog equals the gate's keys", () => {
	test("every area registers exactly the ids the catalog holds", async () => {
		const service = services();

		// One area alone at a time, through the real reconciler: the reconcile is
		// close-first, so each pass leaves exactly that area's contributions.
		const enabled = new Set<string>();
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => enabled.has(areaId),
			contributionEnabledOf: () => true,
			makeHost,
		});

		for (const area of BUILTIN_AREAS) {
			enabled.clear();
			enabled.add(area.id);
			await Effect.runPromise(reconciler.reconcile(service));

			const registered = new Set(allIds(service));
			const catalog = new Set(catalogIds(area.id));

			expect(
				[...registered].sort(),
				`${area.id}: what registers equals what the drill-down keys on`,
			).toEqual([...catalog].sort());
		}
	});

	test("the catalog covers every identity's area", () => {
		for (const identity of BUILTIN_IDENTITIES) {
			expect(Array.isArray(BUILTIN_CONTRIBUTIONS[identity.id])).toBe(true);
		}
	});

	/* A guard so a future area's missing key is a visible failure, not a hole. */
	test("the real area table is the one the catalog is keyed by", () => {
		expect(BUILTIN_AREAS.map((area) => area.id)).toEqual(
			BUILTIN_IDENTITIES.map((identity) => identity.id),
		);
	});

	/* The module door is reachable and idempotent (the store is shared). */
	test("startBuiltins is callable again without a second start", () => {
		startBuiltins();
		startBuiltins();
		expect(Object.keys(getBuiltinsSnapshot().builtins)).toHaveLength(
			BUILTIN_IDENTITIES.length,
		);
	});
});
