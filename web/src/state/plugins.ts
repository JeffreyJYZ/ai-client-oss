import type { Settings } from "@lib/db";
import { type PluginError, PluginLoadFailed } from "@lib/plugins/errors";
import type { HostServices } from "@lib/plugins/host";
import {
	activatePlugin,
	installPlugin,
	type LoadedPlugin,
	MANIFEST_FILE,
	type PreparedPlugin,
	preparePlugin,
	removePlugin,
	unloadPlugin,
} from "@lib/plugins/loader";
import { recordLog } from "@lib/plugins/log";
import {
	manifestSchema,
	type PluginManifest,
	type PluginState,
} from "@lib/plugins/manifest";
import {
	loadDeps,
	pluginInstaller,
	runtime,
	subscribePluginChanges,
} from "@lib/plugins/runtime";
import { publishHostEvent } from "@lib/plugins/services";
import { pluginSource } from "@lib/plugins/source";
import { Cause, Duration, Effect, Exit, Option, Scope } from "effect";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
	getSettings,
	setSettings,
	subscribe as subscribeSettings,
} from "@/state/settings";

/**
 * The plugin manager (spec §3/§9): the one store behind the Plugins section.
 *
 * It is a module snapshot plus a listener set, exactly like `state/settings.ts`
 * and `state/chat.ts`, so React reads it through `useSyncExternalStore` and no
 * new state library appears. Two kinds of state are folded together:
 *
 * - **persisted** — `Settings.pluginsEnabled` and one `PluginState` per plugin
 *   (enabled, version, declared capabilities, the plugin's own data). Nothing
 *   else is written: the manager adds no storage of its own.
 * - **live** — which plugins are loaded right now, which failed and why, and
 *   whether an operation is in flight. This never touches `Settings`.
 *
 * Every effect the store forks is **total**: failures become state (a status
 * and a message) rather than a rejected promise, because the store's `run` may
 * be a fire-and-forget fork, where a rejection has nowhere to go.
 *
 * Loading is **serial**: the module importer binds its globals to the host the
 * loader builds for one plugin (`runtime.ts`'s `loadDeps` explains why), so two
 * loads overlapping would race on `globalThis`.
 */

/** Where a plugin stands right now. */
export type PluginStatus = "loaded" | "disabled" | "failed";

/**
 * One plugin as the UI sees it: the persisted half, the live half, and the
 * decoded manifest (or `null` when the manifest itself is the problem).
 */
export interface PluginRuntimeState {
	readonly state: PluginState;
	readonly status: PluginStatus;
	/** Why it is not running — a decode error or a load failure. */
	readonly error?: string;
	readonly manifest: PluginManifest | null;
	/** An install, load, unload or reload for this plugin is in flight. */
	readonly pending: boolean;
}

/** The one line an install reports: what happened, or why nothing did. */
export interface PluginsNotice {
	readonly ok: boolean;
	readonly text: string;
}

/** The store's snapshot. Replace it whole; never hand back a fresh object. */
export interface PluginsSnapshot {
	readonly enabled: boolean;
	readonly plugins: readonly PluginRuntimeState[];
	readonly notice: PluginsNotice | null;
}

/**
 * Ceiling on one install's source text (and on one fetched document), in
 * characters. An install decodes and stores what it is handed, so without a
 * bound a URL or a picked file could hand it an arbitrarily large document.
 */
export const PLUGIN_SOURCE_MAX_CHARS = 512 * 1024;

/** How long `installFromUrl` waits before it reports a failure. */
export const PLUGIN_FETCH_TIMEOUT = Duration.seconds(20);

/**
 * How many times the settle loop re-plans before it gives up and says so. Each
 * round absorbs one settings change that arrived while a load or unload was in
 * flight, so this is a bound on a pathological write stream, not on the number
 * of plugins (which one round handles in full, serially).
 */
export const MAX_SETTLE_ROUNDS = 8;

/** The `files` record an install carries, and the URL envelope it accepts. */
const filesSchema = z.record(z.string(), z.string());

/**
 * Everything the manager needs from outside itself, injected rather than
 * imported (R13: a project module is never `mock.module`d) — so a test drives
 * the whole manager with a fake settings store, a fake source and the **real**
 * loader, and the app wires the real ones at the bottom of this file.
 */
export interface PluginsDeps {
	readonly readSettings: () => Settings;
	readonly writeSettings: (patch: Partial<Settings>) => void;
	readonly subscribeSettings: (listener: () => void) => () => void;
	readonly listManifests: () => Effect.Effect<readonly unknown[]>;
	readonly install: (
		id: string,
		files: Readonly<Record<string, string>>,
	) => Effect.Effect<PluginManifest, PluginError>;
	readonly uninstall: (id: string) => Effect.Effect<void, PluginLoadFailed>;
	/**
	 * The two phases of a load, split so a reload can validate the new source
	 * **before** it closes the old instance (spec §6/§9). `prepare` decodes the
	 * manifest, opens the plugin's scope, runs the version gate and imports the
	 * entry; `activate` runs the new `setup` inside that scope. The context is
	 * `HostServices` because the real pair builds the plugin's `Host` from the
	 * runtime's registries, and this must happen **inside** the runtime rather
	 * than through a synchronous read: at boot the layer may not be built yet,
	 * and `runSync` over the desktop's promise-backed version read throws
	 * `AsyncFiberError`. A fake that needs no context is assignable here.
	 */
	readonly prepare: (
		id: string,
		raw: unknown,
	) => Effect.Effect<PreparedPlugin, PluginError, HostServices>;
	readonly activate: (
		prepared: PreparedPlugin,
	) => Effect.Effect<LoadedPlugin, PluginError, HostServices>;
	readonly unload: (loaded: LoadedPlugin) => Effect.Effect<void>;
	readonly fetchText: (url: string) => Effect.Effect<string, string>;
	/** Run one of the store's effects — the runtime in the app, a test's own runner. */
	readonly run: (effect: Effect.Effect<void, never, HostServices>) => void;
}

/** The manager surface, as `state/plugins.ts` exposes it. */
export interface PluginsStore {
	readonly getPlugins: () => PluginsSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly usePlugins: () => PluginsSnapshot;
	/** Subscribe to settings, reconcile once, then list what is installed. */
	readonly start: () => void;
	readonly setPluginsEnabled: (on: boolean) => void;
	readonly installFromText: (
		id: string,
		files: Readonly<Record<string, string>>,
	) => void;
	readonly installFromUrl: (url: string) => void;
	readonly uninstall: (id: string) => void;
	readonly setPluginEnabled: (id: string, on: boolean) => void;
	readonly reload: (id: string) => void;
	readonly reloadAll: () => void;
}

/** One plugin's live bookkeeping. Mutated in place; never handed to React. */
interface Entry {
	persisted: PluginState;
	/** The manifest value the loader decodes; `undefined` when not installed. */
	raw: unknown;
	manifest: PluginManifest | null;
	error: string | undefined;
	loaded: LoadedPlugin | undefined;
	pending: boolean;
	/** An explicit unload request (`reload`), consumed by the next plan. */
	forced: boolean;
	/** Bumped whenever the persisted entry changes, or a reload is asked for. */
	revision: number;
	/**
	 * The inputs a load or unload decision was last taken with. A decision that
	 * failed is **not** retried until these change: without this, a load that
	 * cannot succeed is re-planned by the settle loop until the round bound, and
	 * a boot that lists slowly would report a failure it was about to fix.
	 */
	attempted: string | undefined;
}

/** One outstanding lifecycle decision for one plugin. */
interface Step {
	readonly entry: Entry;
	readonly action: "load" | "unload" | "swap";
}

/** A load's two outcomes, kept as data so the effect never fails. */
type LoadOutcome =
	| { readonly ok: true; readonly loaded: LoadedPlugin }
	| { readonly ok: false; readonly detail: string };

/** An acquire's two outcomes, kept as data so the effect never fails. */
type PrepareOutcome =
	| { readonly ok: true; readonly prepared: PreparedPlugin }
	| { readonly ok: false; readonly detail: string };

/** A plugin with nothing persisted yet — the shape a fresh entry starts from. */
const emptyState = (id: string): PluginState => ({
	id,
	enabled: false,
	version: "",
	capabilities: [],
	data: {},
});

/**
 * Whether a persisted entry actually changed. Compared field by field (plus
 * `data` by identity, which is what a plugin's own write replaces) so a
 * settings write from anywhere else in the app — typing in a provider label,
 * adding a memory — does not re-render the Plugins section.
 */
const sameState = (a: PluginState, b: PluginState): boolean =>
	a === b ||
	(a.id === b.id &&
		a.enabled === b.enabled &&
		a.version === b.version &&
		a.data === b.data &&
		a.capabilities.length === b.capabilities.length &&
		a.capabilities.every((name, index) => name === b.capabilities[index]));

/** The readable detail of a subsystem failure, defect or not. */
const describe = (cause: Cause.Cause<PluginError>): string =>
	Option.getOrElse(
		Option.map(Cause.findErrorOption(cause), (error) => error.detail),
		() => Cause.pretty(cause),
	);

/** The readable detail of a string failure, defect or not. */
const describeText = (cause: Cause.Cause<string>): string =>
	Option.getOrElse(Cause.findErrorOption(cause), () => Cause.pretty(cause));

/** A manifest's `id` when the value carries a usable one, else `null`. */
const idIn = (value: unknown): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const id = (value as { readonly id?: unknown }).id;
	return typeof id === "string" && id !== "" ? id : null;
};

/** Total characters in a `files` record — the install bound is measured on it. */
const totalChars = (files: Readonly<Record<string, string>>): number =>
	Object.values(files).reduce((sum, text) => sum + text.length, 0);

/** The snapshot view of one entry. */
const toRuntime = (entry: Entry): PluginRuntimeState => ({
	state: entry.persisted,
	status:
		entry.loaded !== undefined
			? "loaded"
			: entry.error !== undefined
				? "failed"
				: "disabled",
	error: entry.error,
	manifest: entry.manifest,
	pending: entry.pending,
});

/**
 * Build a manager over injected seams. The app builds the one in this module;
 * a test builds its own, so nothing here reaches for IndexedDB, the runtime, the
 * real settings store or React.
 */
export const makePluginsStore = (deps: PluginsDeps): PluginsStore => {
	const listeners = new Set<() => void>();
	const entries = new Map<string, Entry>();
	let enabled = false;
	let notice: PluginsNotice | null = null;
	let started = false;
	/** One settle loop at a time; a reconcile during it is seen by the next re-plan. */
	let settling = false;
	/**
	 * Whether the source has been listed. Before it has, nothing is known about
	 * what is installed, so no load is attempted — otherwise every
	 * enabled-at-boot plugin is reported as "not installed" and then loads the
	 * moment the listing lands.
	 */
	let listed = false;

	let snapshot: PluginsSnapshot = { enabled, plugins: [], notice };

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	/** Replace the snapshot wholesale. This is the only writer of `snapshot`. */
	const publish = (): void => {
		snapshot = {
			enabled,
			plugins: [...entries.values()].map(toRuntime).sort(byName),
			notice,
		};
		notify();
	};

	const setNotice = (value: PluginsNotice | null): void => {
		notice = value;
		publish();
	};

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	/** The current snapshot. Referentially stable between `publish` calls. */
	const getSnapshot = (): PluginsSnapshot => snapshot;

	const usePlugins = (): PluginsSnapshot =>
		useSyncExternalStore(subscribe, getSnapshot);

	const entryOf = (id: string): Entry => {
		const existing = entries.get(id);
		if (existing !== undefined) return existing;
		const created: Entry = {
			persisted: emptyState(id),
			raw: undefined,
			manifest: null,
			error: undefined,
			loaded: undefined,
			pending: false,
			forced: false,
			revision: 0,
			attempted: undefined,
		};
		entries.set(id, created);
		return created;
	};

	/** Persist (or create) one plugin's entry with a manifest's own facts. */
	const upsertPersisted = (
		manifest: PluginManifest,
		options: { readonly enabled?: boolean },
	): void => {
		const list = deps.readSettings().plugins;
		const existing = list.find((entry) => entry.id === manifest.id);
		const next: PluginState = {
			id: manifest.id,
			enabled: options.enabled ?? existing?.enabled ?? false,
			version: manifest.version,
			capabilities: [...manifest.capabilities],
			data: existing?.data ?? {},
		};
		deps.writeSettings({
			plugins:
				existing === undefined
					? [...list, next]
					: list.map((entry) => (entry.id === manifest.id ? next : entry)),
		});
	};

	/**
	 * Apply a load's outcome. Deliberately does **not** reconcile: the settle
	 * loop that ran the load re-plans after every step, which is what keeps one
	 * plugin's load from being started inside another's completion frame.
	 */
	const applyLoad = (id: string, entry: Entry, outcome: LoadOutcome): void => {
		if (entries.get(id) !== entry) return;
		entry.pending = false;
		if (outcome.ok) {
			entry.loaded = outcome.loaded;
			entry.manifest = outcome.loaded.manifest;
			entry.error = undefined;
			recordLog(
				id,
				"info",
				`loaded version ${outcome.loaded.manifest.version}`,
			);
		} else {
			entry.error = outcome.detail;
			recordLog(id, "error", `did not load: ${outcome.detail}`);
		}
		publish();
		if (outcome.ok) publishHostEvent("plugin-loaded", { id });
	};

	/**
	 * Run a prepared plugin's `setup` — but only while `entry` is still the entry
	 * the load was planned for (spec §6/§9). {@link preparePlugin} hands back an
	 * **open** scope, and the entry can change in the gap before `setup` runs:
	 * `uninstall` runs on its own fiber and can `entries.delete(id)` while the
	 * source is being prepared. Activating then would register the plugin's
	 * contributions into a scope nothing will ever close — live and registered,
	 * the store no longer tracking it. So on mismatch the prepared scope is closed
	 * and `None` is returned, without activating.
	 *
	 * This is the **only** door to `deps.activate`; a handoff that calls it
	 * directly reintroduces that orphan.
	 */
	const activateIfCurrent = (
		id: string,
		entry: Entry,
		prepared: PreparedPlugin,
	): Effect.Effect<Option.Option<LoadedPlugin>, PluginError, HostServices> =>
		entries.get(id) === entry
			? deps.activate(prepared).pipe(Effect.map(Option.some))
			: Scope.close(prepared.scope, Exit.void).pipe(
					Effect.as(Option.none<LoadedPlugin>()),
				);

	/** Load one plugin, turning every outcome — including a defect — into state. */
	const loadStep = (entry: Entry): Effect.Effect<void, never, HostServices> => {
		const id = entry.persisted.id;
		const raw = entry.raw;
		const decision: Effect.Effect<
			Option.Option<LoadedPlugin>,
			PluginError,
			HostServices
		> = raw === undefined
			? Effect.fail(
					new PluginLoadFailed({
						detail: `plugin "${id}" is not installed, so there is nothing to load`,
						pluginId: id,
					}),
				)
			: deps
					.prepare(id, raw)
					.pipe(
						Effect.flatMap((prepared) =>
							activateIfCurrent(id, entry, prepared),
						),
					);
		return decision.pipe(
			Effect.map(
				(maybe): Option.Option<LoadOutcome> =>
					Option.map(maybe, (loaded): LoadOutcome => ({ ok: true, loaded })),
			),
			Effect.catchCause((cause) =>
				Effect.succeed(
					Option.some<LoadOutcome>({ ok: false, detail: describe(cause) }),
				),
			),
			Effect.flatMap((outcome) =>
				Effect.sync(() => {
					// `None` means the entry was gone before the plugin activated,
					// so there is no outcome to apply — and nothing was activated.
					if (Option.isNone(outcome)) return;
					applyLoad(id, entry, outcome.value);
				}),
			),
		);
	};

	/**
	 * Unload one plugin. A clean unload clears the entry. A failed one keeps
	 * `loaded` set — the plugin may genuinely still be registered — and records
	 * the error; the decision key stops the settle loop from retrying an
	 * unchanged failure, and the next persisted change or reload retries it.
	 */
	const unloadStep = (entry: Entry): Effect.Effect<void> => {
		const id = entry.persisted.id;
		const loaded = entry.loaded;
		if (loaded === undefined) {
			return Effect.sync(() => {
				entry.pending = false;
				publish();
			});
		}
		return deps.unload(loaded).pipe(
			Effect.as(true),
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					recordLog(id, "warn", `did not unload cleanly: ${describe(cause)}`);
					return false;
				}),
			),
			Effect.flatMap((clean) =>
				Effect.sync(() => {
					if (entries.get(id) !== entry) return;
					entry.pending = false;
					if (!clean) {
						entry.error =
							"the unload reported an error; the plugin may still be registered";
						publish();
						return;
					}
					entry.loaded = undefined;
					entry.error = undefined;
					publish();
					publishHostEvent("plugin-unloaded", { id });
				}),
			),
		);
	};

	/**
	 * Reload one plugin **in two phases** (spec §6/§9): acquire and import the new
	 * source, then close the old instance, then run the new `setup`.
	 *
	 * The order is the whole point, and it is what the old "swap" got wrong.
	 *
	 * - A bad **import** — a syntax error, a missing default export, a bare
	 *   specifier, a manifest that no longer decodes, a refused API version — is
	 *   caught in the acquire phase, **before** the old scope closes, so a reload
	 *   whose new source is invalid leaves the old instance running, registered
	 *   and unchanged, with the reason reported.
	 * - The old instance's `dispose` runs **before** the new `setup`, so a plugin
	 *   that manages shared imperative state outside the registry (a theme
	 *   applying a document class) can never have the old disposal retract what
	 *   the new setup just applied.
	 * - A **`setup` that throws** is the one case two phases cannot make seamless:
	 *   the old instance is already closed, so the result is *nothing loaded*, with
	 *   `status: "failed"` and the error logged. That is honest, unlike a swap that
	 *   kept the row reading `loaded` while the plugin's contributions were gone.
	 *   The trade is deliberate: a failed reload can no longer run old code behind
	 *   a new manifest's name.
	 *
	 * Between closing the old instance and running the new `setup` the plugin's
	 * contributions are absent. That window is bounded to one synchronous stretch
	 * of this fiber — no repaint interleaves in practice — and is preferable to
	 * the alternative a swap produced, a *permanent* retraction.
	 *
	 * The activation goes through {@link activateIfCurrent}, which closes the
	 * prepared scope instead of activating when the entry has gone (or been
	 * replaced) in the gap after the acquire — `uninstall` runs on its own fiber
	 * and can delete the entry while the new source is being prepared, in which
	 * case the reload commits nothing.
	 */
	const swapStep = (entry: Entry): Effect.Effect<void, never, HostServices> => {
		const id = entry.persisted.id;
		const raw = entry.raw;
		const previous = entry.loaded;
		const decision: Effect.Effect<PreparedPlugin, PluginError, HostServices> =
			raw === undefined
				? Effect.fail(
						new PluginLoadFailed({
							detail: `plugin "${id}" is not installed, so there is nothing to reload`,
							pluginId: id,
						}),
					)
				: deps.prepare(id, raw);

		return decision.pipe(
			Effect.map((prepared): PrepareOutcome => ({ ok: true, prepared })),
			Effect.catchCause((cause) =>
				Effect.succeed<PrepareOutcome>({ ok: false, detail: describe(cause) }),
			),
			Effect.flatMap((outcome) => {
				if (!outcome.ok) {
					// The new source is invalid. The old instance was never
					// touched: it keeps running and the reason is reported.
					return Effect.sync(() => {
						if (entries.get(id) !== entry) return;
						entry.pending = false;
						entry.error = outcome.detail;
						recordLog(id, "error", `reload failed: ${outcome.detail}`);
						publish();
					});
				}
				const prepared = outcome.prepared;
				return Effect.gen(function* () {
					// The new source is acquired and imported, so the reload is
					// committed from here: close the old instance, then run the new
					// `setup`. This order is what stops the old disposal retracting
					// the new setup's own application.
					if (previous !== undefined) {
						yield* deps.unload(previous).pipe(
							Effect.catchCause((cause) =>
								Effect.sync(() => {
									recordLog(
										id,
										"warn",
										`the previous version did not unload cleanly: ${describe(cause)}`,
									);
								}),
							),
						);
					}
					// `activateIfCurrent` closes the prepared scope instead of
					// activating when the entry has gone (or been replaced) — the
					// reload then commits nothing and touches no state.
					const activated = yield* activateIfCurrent(id, entry, prepared).pipe(
						Effect.map(
							(maybe): Option.Option<LoadOutcome> =>
								Option.map(
									maybe,
									(loaded): LoadOutcome => ({ ok: true, loaded }),
								),
						),
						Effect.catchCause((cause) =>
							Effect.succeed(
								Option.some<LoadOutcome>({
									ok: false,
									detail: describe(cause),
								}),
							),
						),
					);
					yield* Effect.sync(() => {
						if (Option.isNone(activated)) return;
						const outcome = activated.value;
						if (entries.get(id) !== entry) return;
						entry.pending = false;
						if (outcome.ok) {
							entry.loaded = outcome.loaded;
							entry.manifest = outcome.loaded.manifest;
							entry.error = undefined;
							recordLog(
								id,
								"info",
								`reloaded version ${outcome.loaded.manifest.version}`,
							);
							publish();
							publishHostEvent("plugin-loaded", { id });
							return;
						}
						// The old instance is closed and the new setup failed, so
						// nothing is loaded. Say so rather than report `loaded` over
						// an empty registry; recording the decision key stops the
						// settle loop retrying an unchanged failure.
						entry.loaded = undefined;
						entry.error = outcome.detail;
						entry.attempted = decisionKey(entry);
						recordLog(id, "error", `reload failed: ${outcome.detail}`);
						publish();
					});
				});
			}),
		);
	};

	/**
	 * Everything a load or unload decision depends on: the master switch, the
	 * entry's revision (bumped by a persisted change or a reload) and whether the
	 * source has listed it. A decision already taken with these inputs is not
	 * taken again, so a failure is reported once rather than re-planned — and any
	 * of the three changing is what makes a retry legitimate.
	 */
	const decisionKey = (entry: Entry): string =>
		`${enabled ? "on" : "off"}:${entry.revision}:${entry.raw === undefined ? "unlisted" : "listed"}`;

	/**
	 * The lifecycle decisions that are currently outstanding, in list order.
	 * Pure: it reads state and mutates nothing. Recording a decision key is the
	 * settle loop's job, **at the moment a step runs** — a decision that is
	 * planned but never executed (the round bound is reached first) must not be
	 * recorded, or the entry would look already-tried and could never be retried.
	 */
	const planOf = (): readonly Step[] => {
		const plan: Step[] = [];
		for (const entry of entries.values()) {
			if (entry.pending) continue;
			const shouldRun = enabled && entry.persisted.enabled;
			if (entry.forced) {
				// An explicit reload: swap the live instance for a fresh one with
				// no unloaded gap (`swapStep`). A plugin that is not currently
				// running has nothing to swap, so it falls through to the ordinary
				// rule and is loaded by it.
				if (shouldRun && entry.loaded !== undefined) {
					plan.push({ entry, action: "swap" });
					continue;
				}
			}
			if (shouldRun && entry.loaded === undefined) {
				if (!listed) continue;
				if (entry.attempted === decisionKey(entry)) continue;
				plan.push({ entry, action: "load" });
			} else if (!shouldRun && entry.loaded !== undefined) {
				if (entry.attempted === decisionKey(entry)) continue;
				plan.push({ entry, action: "unload" });
			}
		}
		return plan;
	};

	/**
	 * Work through the outstanding decisions **in one fiber, one plugin at a
	 * time**, re-planning after every round until there is nothing left to do.
	 * Serial is a correctness property, not a preference: the module importer
	 * binds the host globals for the plugin being imported, so two overlapping
	 * loads would race on `globalThis`, and a step that started the next load
	 * from its own completion frame would nest runtime entries — the shape that
	 * overflows the stack as the plugin count grows.
	 *
	 * Re-planning, rather than a queue built once, is what makes a reconcile that
	 * arrives mid-round free: re-planning reads live state, and the loop's last
	 * re-plan and its clearing of `settling` are in the same synchronous stretch,
	 * so a decision cannot slip through the exit.
	 */
	const settle = (): void => {
		if (settling) return;
		settling = true;
		deps.run(
			Effect.gen(function* () {
				let rounds = 0;
				// A plan is read, and its decisions are recorded, only as each step
				// is about to run (`attempted`, and consuming `forced`). A plan the
				// round bound never reaches therefore leaves no trace: those
				// decisions stay outstanding, and the next `settle` — which any
				// settings change calls — retries them.
				let plan = planOf();
				while (plan.length > 0 && rounds < MAX_SETTLE_ROUNDS) {
					rounds += 1;
					for (const step of plan) {
						step.entry.pending = true;
						step.entry.forced = false;
						if (step.action !== "swap") {
							step.entry.attempted = decisionKey(step.entry);
						}
					}
					publish();
					yield* Effect.forEach(
						plan,
						(step) =>
							step.action === "load"
								? loadStep(step.entry)
								: step.action === "unload"
									? unloadStep(step.entry)
									: swapStep(step.entry),
						{ concurrency: 1 },
					);
					plan = planOf();
				}
				yield* Effect.sync(() => {
					settling = false;
					if (plan.length > 0) {
						recordLog(
							undefined,
							"warn",
							`plugin state did not settle after ${MAX_SETTLE_ROUNDS} rounds; a further settings change will retry`,
						);
					}
				});
			}),
		);
	};

	/**
	 * Bring the live half in line with the persisted half (spec §3/§9): the
	 * switch, and every plugin's `enabled`, decide what runs. Called on every
	 * settings change and by every action, so a plugin is never left running that
	 * the settings no longer ask for — and never left stopped that they do —
	 * without a page reload.
	 */
	const reconcile = (): void => {
		const settings = deps.readSettings();
		const wasEnabled = enabled;
		enabled = settings.pluginsEnabled;
		let changed = enabled !== wasEnabled;

		for (const persisted of settings.plugins) {
			const entry = entryOf(persisted.id);
			if (!sameState(entry.persisted, persisted)) {
				changed = true;
				// The user (or an import) asked again, so a decision that already
				// failed is worth taking once more.
				entry.revision += 1;
			}
			entry.persisted = persisted;
		}

		if (changed) publish();
		settle();
	};

	/**
	 * Decode and store one plugin's files, then persist a disabled entry for it.
	 * The single install path: pasted text, a URL and the file picker all land
	 * here, so validation, the size bound and the persisted shape cannot differ
	 * between them.
	 */
	const installFiles = (
		id: string,
		files: Readonly<Record<string, string>>,
	): Effect.Effect<string, string> =>
		Effect.gen(function* () {
			const size = totalChars(files);
			if (size > PLUGIN_SOURCE_MAX_CHARS) {
				return yield* Effect.fail(
					`that install is ${size} characters, over the ${PLUGIN_SOURCE_MAX_CHARS}-character limit for one plugin`,
				);
			}

			const manifest = yield* deps
				.install(id, files)
				.pipe(Effect.mapError((error) => error.detail));

			yield* Effect.sync(() => {
				const entry = entryOf(manifest.id);
				// The decoded manifest is what the loader decodes again when it
				// loads; a later listing replaces it with the source's own raw
				// value. `deps.install` owns the one parse of `plugin.json` — it
				// decodes, validates and writes — so the missing-manifest and
				// invalid-JSON messages have a single home and cannot drift from
				// what a pasted, fetched or picked install reports.
				entry.raw = manifest;
				entry.manifest = manifest;
				entry.error = undefined;
				publish();
				upsertPersisted(manifest, {});
			});

			return `Installed "${manifest.name}" ${manifest.version}.`;
		});

	/** The install outcome, as the one line the section shows. */
	const reportInstall = (
		effect: Effect.Effect<string, string>,
	): Effect.Effect<void> =>
		effect.pipe(
			Effect.map((text): PluginsNotice => ({ ok: true, text })),
			Effect.catchCause((cause) =>
				Effect.succeed<PluginsNotice>({ ok: false, text: describeText(cause) }),
			),
			Effect.flatMap((value) => Effect.sync(() => setNotice(value))),
		);

	const installFromText = (
		id: string,
		files: Readonly<Record<string, string>>,
	): void => {
		setNotice(null);
		deps.run(reportInstall(installFiles(id, files)));
	};

	const installFromUrl = (url: string): void => {
		setNotice(null);
		deps.run(
			reportInstall(
				Effect.gen(function* () {
					const text = yield* deps.fetchText(url);
					const files = yield* Effect.try({
						try: () => JSON.parse(text) as unknown,
						catch: (cause) => `${url} did not return JSON: ${String(cause)}`,
					}).pipe(
						Effect.flatMap((raw) =>
							Effect.try({
								try: () => filesSchema.parse(raw),
								catch: (cause) =>
									`${url} did not return a plugin's files as JSON ({ "${MANIFEST_FILE}": "…" }): ${String(cause)}`,
							}),
						),
					);
					return yield* installFiles("", files);
				}),
			),
		);
	};

	const setPluginsEnabled = (on: boolean): void => {
		deps.writeSettings({ pluginsEnabled: on });
		reconcile();
	};

	const setPluginEnabled = (id: string, on: boolean): void => {
		const manifest = entries.get(id)?.manifest ?? null;
		const list = deps.readSettings().plugins;
		const existing = list.find((entry) => entry.id === id);
		const base = existing ?? entries.get(id)?.persisted ?? emptyState(id);
		const next: PluginState = {
			...base,
			id,
			enabled: on,
			version: manifest?.version ?? base.version,
			capabilities:
				manifest === null ? [...base.capabilities] : [...manifest.capabilities],
		};
		deps.writeSettings({
			plugins:
				existing === undefined
					? [...list, next]
					: list.map((entry) => (entry.id === id ? next : entry)),
		});
		reconcile();
	};

	/**
	 * Reload one plugin from its source (spec §6): re-list the manifests — a
	 * reload may be a changed `plugin.json`, which the source lists verbatim —
	 * then force a swap of that plugin's live instance. The entry **text** is
	 * re-read by the loader on every load, so a changed entry is picked up
	 * whether or not the manifest moved.
	 */
	const reload = (id: string): void => {
		deps.run(
			Effect.gen(function* () {
				const manifests = yield* deps.listManifests();
				yield* Effect.sync(() => {
					applyManifests(manifests);
					const entry = entries.get(id);
					// Recorded even when a step for this plugin is in flight. The
					// settle loop re-plans after every step and its last re-plan is
					// in the same synchronous stretch as clearing `settling`, so a
					// forced swap set here is picked up by the running loop (or by
					// this call's own `settle` if it has already stopped). Dropping
					// the request because `pending` was true is exactly the file
					// change a user cannot diagnose.
					if (entry === undefined) return;
					entry.forced = true;
					entry.revision += 1;
				});
				yield* Effect.sync(settle);
			}),
		);
	};

	/**
	 * Reload every plugin (spec §6): the manual door for the web build, which has
	 * no watcher, and for a desktop watcher miss. One listing, then one forced
	 * swap per plugin, worked serially by the settle loop.
	 */
	const reloadAll = (): void => {
		deps.run(
			Effect.gen(function* () {
				const manifests = yield* deps.listManifests();
				yield* Effect.sync(() => {
					applyManifests(manifests);
					for (const entry of entries.values()) {
						entry.forced = true;
						entry.revision += 1;
					}
				});
				yield* Effect.sync(settle);
			}),
		);
	};

	const uninstall = (id: string): void => {
		const entry = entries.get(id);
		deps.run(
			Effect.gen(function* () {
				if (entry?.loaded !== undefined) {
					yield* deps.unload(entry.loaded).pipe(
						Effect.catchCause((cause) =>
							Effect.sync(() => {
								recordLog(
									id,
									"warn",
									`uninstall: the unload reported ${describe(cause)}`,
								);
							}),
						),
					);
				}

				const removed = yield* deps.uninstall(id).pipe(
					Effect.as(true),
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							recordLog(
								id,
								"error",
								`could not remove plugin "${id}": ${describe(cause)}`,
							);
							return false;
						}),
					),
				);
				// Removal failed: keep the entry, so the row still says what is
				// still installed instead of pretending it is gone.
				if (!removed) return;

				yield* Effect.sync(() => {
					entries.delete(id);
					deps.writeSettings({
						plugins: deps
							.readSettings()
							.plugins.filter((plugin) => plugin.id !== id),
					});
					publish();
					publishHostEvent("plugin-unloaded", { id });
				});
			}),
		);
	};

	/**
	 * Fold a listing of the source's manifests into the entries (spec §9): each
	 * listed plugin gets its raw manifest and its decoded shape, and a manifest
	 * that fails to decode is listed *with its reason* rather than dropped. A
	 * manifest with no usable id cannot be addressed at all, so it is reported in
	 * the log instead. `listed` is set here because this is where the store first
	 * learns what is installed — and only then may a load be attempted.
	 *
	 * Split out of {@link refresh} because a reload re-lists the source too (a
	 * changed `plugin.json` is a change the desktop watcher reports) and both
	 * paths must fold a listing identically.
	 */
	const applyManifests = (manifests: readonly unknown[]): void => {
		for (const raw of manifests) {
			const parsed = manifestSchema.safeParse(raw);
			const id = parsed.success ? parsed.data.id : idIn(raw);
			if (id === null) {
				recordLog(
					undefined,
					"warn",
					"an installed plugin has no usable id in its manifest and could not be listed",
				);
				continue;
			}
			const entry = entryOf(id);
			entry.raw = raw;
			if (parsed.success) {
				// A previous *decode* error is cleared by a manifest that now
				// decodes; a load error is not, because the load never succeeded
				// and nothing about that changed.
				if (entry.manifest === null) entry.error = undefined;
				entry.manifest = parsed.data;
			} else {
				entry.manifest = null;
				entry.error = String(parsed.error);
			}
		}
		// Only now does the store know what is installed, so only now may a
		// load be attempted (see `listed`).
		listed = true;
		publish();
	};

	/** List what is installed, fold it in, then reconcile the live half. */
	const refresh = (): Effect.Effect<void> =>
		Effect.gen(function* () {
			const manifests = yield* deps.listManifests();
			yield* Effect.sync(() => {
				applyManifests(manifests);
				reconcile();
			});
		});

	const start = (): void => {
		if (started) return;
		started = true;
		deps.subscribeSettings(reconcile);
		reconcile();
		deps.run(refresh());
	};

	return {
		getPlugins: getSnapshot,
		subscribe,
		usePlugins,
		start,
		setPluginsEnabled,
		installFromText,
		installFromUrl,
		uninstall,
		setPluginEnabled,
		reload,
		reloadAll,
	};
};

/** Sort by the name a user sees, then by id, so the list is stable across runs. */
const byName = (a: PluginRuntimeState, b: PluginRuntimeState): number => {
	const aName = a.manifest?.name ?? a.state.id;
	const bName = b.manifest?.name ?? b.state.id;
	return aName === bName
		? a.state.id.localeCompare(b.state.id)
		: aName.localeCompare(bName);
};

/* ------------------------------------------------------------------- wiring */

/**
 * Whether a `Content-Length` header declares a body past the source limit. The
 * header counts **bytes** and {@link PLUGIN_SOURCE_MAX_CHARS} counts
 * **characters**, and a UTF-8 body is never fewer bytes than characters — so
 * this is a conservative fast reject: it can refuse a multibyte body whose
 * character count is under the limit, which the post-read check would have
 * accepted. Pure, and tested directly.
 */
export const declaredBodyOverLimit = (
	contentLength: string | null,
): boolean => {
	if (contentLength === null) return false;
	const declared = Number(contentLength);
	return Number.isFinite(declared) && declared > PLUGIN_SOURCE_MAX_CHARS;
};

/**
 * Fetch a plugin's files as JSON (spec §6). **Time is bounded; memory is not.**
 * The 20-second deadline makes a stalled host a reported failure rather than a
 * spinner that never resolves, and the text is capped to
 * {@link PLUGIN_SOURCE_MAX_CHARS} — but only *after* it is read, so the whole
 * body is buffered in the webview first. The one cheap memory guard is a
 * declared `Content-Length` over the limit, refused before the body is read; a
 * chunked response declares no length and is still read whole before the cap.
 */
const realFetchText = (url: string): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () => fetch(url),
			catch: (cause) => `could not fetch ${url}: ${String(cause)}`,
		});
		if (!response.ok) {
			return yield* Effect.fail(
				`fetching ${url} returned HTTP ${response.status}`,
			);
		}
		const declared = response.headers.get("content-length");
		if (declaredBodyOverLimit(declared)) {
			return yield* Effect.fail(
				`${url} declares a ${declared}-byte body, over the ${PLUGIN_SOURCE_MAX_CHARS}-character install limit; refusing to read it`,
			);
		}
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (cause) => `could not read ${url}: ${String(cause)}`,
		});
		if (text.length > PLUGIN_SOURCE_MAX_CHARS) {
			return yield* Effect.fail(
				`${url} returned more than ${PLUGIN_SOURCE_MAX_CHARS} characters; a plugin install is bounded to that`,
			);
		}
		return text;
	}).pipe(
		Effect.timeout(PLUGIN_FETCH_TIMEOUT),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(
				`fetching ${url} did not finish within ${Duration.toMillis(PLUGIN_FETCH_TIMEOUT)}ms`,
			),
		),
	);

const realDeps: PluginsDeps = {
	readSettings: getSettings,
	writeSettings: (patch) => setSettings(patch),
	subscribeSettings,
	listManifests: () => pluginSource.list(),
	install: (id, files) => installPlugin(id, files, pluginInstaller),
	uninstall: (id) => removePlugin(id, pluginInstaller),
	prepare: (id, raw) =>
		loadDeps(id).pipe(Effect.flatMap((seams) => preparePlugin(raw, seams))),
	activate: (prepared) => activatePlugin(prepared),
	unload: (loaded) => unloadPlugin(loaded),
	fetchText: realFetchText,
	run: (effect) => {
		runtime.runFork(effect);
	},
};

const store = makePluginsStore(realDeps);

// Boot the manager once, at import: subscribe to settings (whose hydration is
// itself asynchronous, so this catches the stored value whenever it arrives),
// reconcile what is already known, then list what is installed.
store.start();

// Listen for the desktop watcher's change events (spec §6). Rust names the
// plugin whose source changed; the manager owns the swap, so the subscription is
// wired here — `runtime.ts` already exports the seam and this module already
// depends on it. On the web build there is no watcher, so the subscription is a
// no-op and the section's manual action is the web build's reload door.
runtime.runFork(subscribePluginChanges(store.reload));

/** The Plugins section's snapshot. */
export const usePlugins = store.usePlugins;
export const getPlugins = store.getPlugins;
export const subscribe = store.subscribe;
export const setPluginsEnabled = store.setPluginsEnabled;
export const installFromText = store.installFromText;
export const installFromUrl = store.installFromUrl;
export const uninstall = store.uninstall;
export const setPluginEnabled = store.setPluginEnabled;
export const reload = store.reload;
export const reloadAll = store.reloadAll;
