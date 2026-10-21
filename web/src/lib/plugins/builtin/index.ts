import { BUILTIN_AREAS, type BuiltinArea } from "@lib/plugins/areas";
import {
	type Disposable,
	type Host,
	type HostRegistry,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { recordLog } from "@lib/plugins/log";
import type { RegistryEntry } from "@lib/plugins/registry";
import { Cause, Effect, Exit, Scope } from "effect";
import {
	getBuiltinsSnapshot,
	subscribe as subscribeBuiltins,
} from "@/state/builtins";

/**
 * Registration and reconcile (spec "Registration, teardown, reconcile"): the
 * one place a built-in area is turned into live contributions.
 *
 * Each area registers through a `Host` built for **its own `Scope`**, so the
 * loader's already-proven trace-free teardown is the only teardown — closing
 * the scope removes exactly that area's contributions, and a reconcile is a
 * close of every live scope followed by a registration of every enabled area.
 * A disabled contribution is therefore never registered at all: "off" is
 * indistinguishable from "never existed", the strongest guarantee available,
 * and it needs no read-time filter every consumer could forget.
 *
 * Task 4 applies that same rule one level down: an area's registrar is handed
 * a **gated host** whose registration doors skip any contribution whose id the
 * store records as `false` — the id the registry already holds (a UI entry's
 * `id`, a tool's wire name, a command's id, a settings section's id). One entry
 * off therefore leaves its siblings registered, and a contribution-only change
 * (which still reconciles every area) can never empty one.
 *
 * The identities and registrars come from `areas.ts`; the *enabled* state comes
 * from the store (`state/builtins.ts`), which this module also imports so a
 * toggle re-reconciles. The two are joined by {@link makeBuiltinsReconciler},
 * whose dependencies are injected the way `state/plugins.ts` injects its own,
 * so a test drives the real loop over a fake enabled-state source.
 *
 * This file replaces the old `registerBuiltins(host)` aggregator: writing a new
 * aggregator beside the table would be a second list to keep in step.
 */

/** One live area: its id, and the scope every registration it made is on. */
export interface LiveBuiltinArea {
	readonly id: string;
	readonly scope: Scope.Closeable;
}

/** What the reconciler needs from outside itself. */
export interface BuiltinsReconcilerDeps {
	/** The area table, walked in registration order. */
	readonly areas: readonly BuiltinArea[];
	/** Whether an area is on right now — read per area, per reconcile. */
	readonly enabledOf: (areaId: string) => boolean;
	/**
	 * Whether one contribution of an area is on right now — read per
	 * registration, per reconcile. The id is the one the registry already holds
	 * for it, so the toggle layer never invents a second namespace; absent (or
	 * unknown) means on, which is what makes a renamed contribution's stale
	 * state inert.
	 */
	readonly contributionEnabledOf: (
		areaId: string,
		contributionId: string,
	) => boolean;
	/** The host factory, so each area gets a host bound to its own id and scope. */
	readonly makeHost: (
		services: HostServicesShape,
		areaId: string,
		scope: Scope.Scope,
	) => Host;
}

/** The reconciler, as this module exposes it. */
export interface BuiltinsReconciler {
	/** Bring the live areas in line with the enabled state. Idempotent. */
	readonly reconcile: (services: HostServicesShape) => Effect.Effect<void>;
	/** The areas live right now, in registration order (a test reads it). */
	readonly live: () => readonly LiveBuiltinArea[];
}

/**
 * Whether a contribution is **enabled**, given the store's recorded overrides —
 * the production rule in one place, exported so the wiring and the tests call
 * the same function rather than a copy of it (a copy lets `!== false` silently
 * become `=== true` with every test still green).
 *
 * It answers the question the wiring asks — "is this contribution on?" — so no
 * operator is left at a call site to drift. The rule is deliberately
 * `!== false`: an absent area, an absent contribution and an id no registry
 * holds all resolve to `undefined`, and all of them are **enabled** — which is
 * what makes a renamed built-in's stale state inert (spec "Persistence":
 * unknown ids are ignored).
 */
export const contributionEnabled = (
	contributions: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
	areaId: string,
	contributionId: string,
): boolean => contributions[areaId]?.[contributionId] !== false;

/**
 * Whether an area is **enabled**, given the resolved area flags — the
 * production rule in one place, exported so the wiring and the tests call the
 * same function rather than a copy of it (a copy lets the operator silently
 * change with every test still green), exactly as {@link contributionEnabled}
 * does one level down.
 *
 * The map it reads is the store's **resolved** `builtins` (`state/builtins.ts`
 * `resolve`), which fills an explicit flag for every identity, so `=== true`
 * and the contributions' absent-means-on form agree on every value it can
 * carry; the strict form is stated because this helper answers "is the area's
 * resolved flag on?", and a partial map is pinned in the tests as off so a
 * drift to the other form fails.
 */
export const areaEnabled = (
	builtins: Readonly<Record<string, boolean>>,
	areaId: string,
): boolean => builtins[areaId] === true;

/**
 * An inert handle for a contribution that is off. Returned in place of the real
 * one so a registrar that disposes what it registered cannot tell the
 * difference — a skipped registration leaves no trace by construction.
 */
const skipped: Disposable = { dispose: () => {} };

/** Whether one contribution id of the area being registered is on right now. */
type ContributionFilter = (contributionId: string) => boolean;

/**
 * A registry view whose `register` skips a contribution that is off. The check
 * is on the entry's own `id` — the id the registry already holds — so the
 * filter needs no second namespace and every registry kind is covered by one
 * helper.
 */
const gateRegistry = <E extends RegistryEntry>(
	registry: HostRegistry<E>,
	enabled: ContributionFilter,
): HostRegistry<E> => ({
	...registry,
	register: (entry) => (enabled(entry.id) ? registry.register(entry) : skipped),
});

/**
 * The host an area's registrar receives: the real host with every registration
 * door gated on that area's contribution state, so a contribution that is off
 * is never registered at all (spec "Registration, teardown, reconcile").
 *
 * Each door is keyed by the id the registry already holds: a UI entry's `id`, a
 * tool's wire name, a command's or provider's `id`, a settings section's `id`, a
 * renderer's kind, a theme's `id`. Everything that is not a registration —
 * `run`, `on`, `log`, `chat`, `db`, and the registries' reads — passes through
 * untouched.
 */
const gateHost = (host: Host, enabled: ContributionFilter): Host => ({
	...host,
	// `ui` is spread whole so its shared `kit` survives.
	ui: {
		...host.ui,
		register: (entry) =>
			enabled(entry.id) ? host.ui.register(entry) : skipped,
	},
	commands: gateRegistry(host.commands, enabled),
	providers: gateRegistry(host.providers, enabled),
	presets: {
		...host.presets,
		register: (preset, label) =>
			enabled(
				typeof preset === "object" && preset !== null
					? String((preset as { readonly id?: unknown }).id)
					: "",
			)
				? host.presets.register(preset, label)
				: skipped,
	},
	pipeline: gateRegistry(host.pipeline, enabled),
	tools: {
		...host.tools,
		register: (tool, label) =>
			enabled(tool.declaration.name)
				? host.tools.register(tool, label)
				: skipped,
	},
	settings: {
		...host.settings,
		registerSection: (section) =>
			enabled(section.id) ? host.settings.registerSection(section) : skipped,
	},
	renderers: {
		...host.renderers,
		register: (kind, component) =>
			enabled(kind) ? host.renderers.register(kind, component) : skipped,
	},
	themes: {
		...host.themes,
		register: (theme) =>
			enabled(theme.id) ? host.themes.register(theme) : skipped,
	},
});

/**
 * Close one area's scope, **absorbing every cause**. This is the teardown
 * cleanup pass's own close: it runs when the reconcile is already being
 * interrupted, to close the scopes the aborted pass did not reach, so it must
 * never abort on the interrupt it is cleaning up after. A non-interrupt defect
 * is still logged, exactly as {@link closeQuietly} logs it, and closing an
 * already-closed scope is a no-op, so a scope the normal pass already closed
 * costs nothing here.
 */
const closeAbsorbing = (
	areaId: string,
	scope: Scope.Closeable,
): Effect.Effect<void> =>
	Scope.close(scope, Exit.void).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterrupts(cause)
				? Effect.void
				: Effect.sync(() =>
						recordLog(
							areaId,
							"error",
							`closing the built-in area "${areaId}" faulted: ${Cause.pretty(cause)}`,
						),
					),
		),
	);

/**
 * Close one area's scope, reporting — but never treating as a fault —
 * whatever the finalizers end with. `Scope.close`'s typed error is `never`, so
 * a finalizer that dies escapes as a defect: at boot that travels out of
 * `runtime.runPromise` and leaves a blank app. A defect is logged against the
 * area id and the reconcile carries on; the finalizers that did run have
 * already undone their own work.
 *
 * An **interruption is re-raised, not logged** — the rule `host.run` follows: a
 * cancelled reconcile is a teardown, not a fault, and recovering it would emit
 * a bogus error and run the reconcile to completion after its caller stopped
 * it.
 */
const closeQuietly = (
	areaId: string,
	scope: Scope.Closeable,
): Effect.Effect<void> =>
	Scope.close(scope, Exit.void).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterrupts(cause)
				? Effect.failCause(cause)
				: Effect.sync(() =>
						recordLog(
							areaId,
							"error",
							`closing the built-in area "${areaId}" faulted: ${Cause.pretty(cause)}`,
						),
					),
		),
	);

/**
 * The reconcile loop over injected seams.
 *
 * Two properties are the whole point, and both are load-bearing:
 *
 * - **Close first, then register.** Every live scope is closed before anything
 *   is registered again, so a reconcile that runs on every toggle cannot
 *   accumulate a second copy of an area's contributions.
 * - **Atomic per area.** A registrar that throws has whatever it registered
 *   rolled back with its scope, the failure is logged **with the area id**, and
 *   the loop carries on — so one area's failure can never leave another area
 *   closed but unregistered (the half-registered state the spec forbids).
 */
export const makeBuiltinsReconciler = (
	deps: BuiltinsReconcilerDeps,
): BuiltinsReconciler => {
	let live: LiveBuiltinArea[] = [];

	const reconcile = (services: HostServicesShape): Effect.Effect<void> =>
		Effect.gen(function* () {
			// Tear down. Closing runs the finalizers the registries attached to
			// this scope, so each area's entries — and its subscriptions, notify
			// queues and `host.run` fibres — are gone before anything
			// re-registers.
			//
			// `live` is cleared up front, so the invariant `live` names every
			// scope still open would be broken for the width of this loop — which
			// is why the loop is wrapped in `ensuring`: an interrupt is re-raised
			// by `closeQuietly`, and without the cleanup pass the areas after the
			// interruption point would be abandoned with their scopes open,
			// leaking everything they own (including an `app.themes` `host.run`
			// subscriber — the very leak the seam exists to stop). Closing an
			// already-closed scope is a no-op, so the pass is safe to always run.
			const previous = live;
			live = [];
			const teardownOrder = [...previous].reverse();
			yield* Effect.forEach(
				teardownOrder,
				(area) => closeQuietly(area.id, area.scope),
				{ discard: true },
			).pipe(
				Effect.ensuring(
					Effect.forEach(
						teardownOrder,
						(area) => closeAbsorbing(area.id, area.scope),
						{ discard: true },
					),
				),
			);

			// Register each enabled area into a scope of its own, through a host
			// gated on that area's contribution state so a disabled contribution
			// is never registered.
			for (const area of deps.areas) {
				if (!deps.enabledOf(area.id)) continue;
				const scope = yield* Scope.make();
				const host = gateHost(
					deps.makeHost(services, area.id, scope),
					(contributionId) =>
						deps.contributionEnabledOf(area.id, contributionId),
				);
				const outcome = yield* Effect.exit(
					Effect.try({
						try: () => area.register(host),
						catch: (cause) => String(cause),
					}),
				);
				if (Exit.isFailure(outcome)) {
					// Roll the failed area's partial work back, name the area, and
					// continue: the other areas must still be registered.
					yield* closeQuietly(area.id, scope);
					yield* Effect.sync(() =>
						recordLog(
							area.id,
							"error",
							`the built-in area "${area.id}" did not register and was rolled back: ${Cause.pretty(outcome.cause)}`,
						),
					);
					continue;
				}
				live.push({ id: area.id, scope });
			}
		});

	return { reconcile, live: () => live };
};

/* ------------------------------------------------------------------- wiring */

const reconciler = makeBuiltinsReconciler({
	areas: BUILTIN_AREAS,
	enabledOf: (areaId) => areaEnabled(getBuiltinsSnapshot().builtins, areaId),
	// The one production rule, not a copy of it. An id no registry holds is
	// simply never asked about, so stale state is inert.
	contributionEnabledOf: (areaId, contributionId) =>
		contributionEnabled(
			getBuiltinsSnapshot().contributions,
			areaId,
			contributionId,
		),
	makeHost,
});

/**
 * Serialise calls to an async runner. A call made while one is in flight sets a
 * pending flag and returns; the in-flight run starts **exactly one more** when
 * it finishes.
 *
 * That is the property a reconcile needs, not a convenience: `reconcile` clears
 * its live list before it closes and re-registers, so two overlapping passes
 * would both find nothing to close and accumulate one scope per area — and the
 * store notifies once per settings change, so a burst of changes would do it.
 * Serialising makes the overlap unreachable rather than merely unproduced:
 * every built-in finalizer runs synchronously today, so a second pass happens
 * to be safe right now, but a future async finalizer or registrar would leak a
 * scope per toggle without this.
 */
export const makeCoalescingRunner = (
	run: () => Effect.Effect<void>,
): (() => void) => {
	let inFlight = false;
	let pending = false;

	return (): void => {
		if (inFlight) {
			pending = true;
			return;
		}
		inFlight = true;
		Effect.runFork(
			Effect.gen(function* () {
				let again = true;
				while (again) {
					yield* run();
					// Read-and-clear in one synchronous step, so a notification
					// that arrives while `run` executes is seen exactly once.
					again = yield* Effect.sync(() => {
						const next = pending;
						pending = false;
						return next;
					});
				}
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						inFlight = false;
					}),
				),
			),
		);
	};
};

let bootedServices: HostServicesShape | undefined;
let subscribed = false;

/** The notify path's serialised reconcile source; see {@link makeCoalescingRunner}. */
const notifyBuiltins = makeCoalescingRunner(() =>
	bootedServices === undefined
		? Effect.void
		: reconciler.reconcile(bootedServices),
);

/**
 * A store change while the app runs re-reconciles with the services captured at
 * boot, **coalesced**: a change that arrives while a reconcile is in flight runs
 * once more when it finishes rather than beside it. A change before boot (the
 * store self-starts at import, before the runtime resolves its services) is
 * ignored: the boot reconcile reads the then-current snapshot, so nothing it
 * would have done is missed.
 */
const onBuiltinsChanged = (): void => {
	if (bootedServices === undefined) return;
	notifyBuiltins();
};

/**
 * Register every enabled area, and keep registering as the store changes. The
 * app calls this once at boot with the runtime's `HostServices`; the same call
 * installs the store subscription, so every later toggle or preset reconciles.
 *
 * Idempotent in the way that matters: calling it again re-reconciles (a close
 * of every live scope, then a registration of the enabled set), which is what
 * makes it safe to call on every toggle.
 */
export const reconcileBuiltins = (
	services: HostServicesShape,
): Effect.Effect<void> => {
	bootedServices = services;
	if (!subscribed) {
		subscribed = true;
		subscribeBuiltins(onBuiltinsChanged);
	}
	return reconciler.reconcile(services);
};
