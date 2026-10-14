import { BUILTIN_AREAS, type BuiltinArea } from "@lib/plugins/areas";
import { type Host, type HostServicesShape, makeHost } from "@lib/plugins/host";
import { recordLog } from "@lib/plugins/log";
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
			// this scope, so each area's entries — and its subscriptions and
			// notify queues — are gone before anything re-registers.
			const previous = live;
			live = [];
			for (const area of [...previous].reverse()) {
				yield* Scope.close(area.scope, Exit.void);
			}

			// Register each enabled area into a scope of its own.
			for (const area of deps.areas) {
				if (!deps.enabledOf(area.id)) continue;
				const scope = yield* Scope.make();
				const host = deps.makeHost(services, area.id, scope);
				const outcome = yield* Effect.exit(
					Effect.try({
						try: () => area.register(host),
						catch: (cause) => cause,
					}),
				);
				if (Exit.isFailure(outcome)) {
					// Roll the failed area's partial work back, name the area, and
					// continue: the other areas must still be registered.
					yield* Scope.close(scope, Exit.void);
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
	enabledOf: (areaId) => getBuiltinsSnapshot().builtins[areaId] === true,
	makeHost,
});

let bootedServices: HostServicesShape | undefined;
let subscribed = false;

/**
 * A store change while the app runs re-reconciles with the services captured at
 * boot. A change before boot (the store self-starts at import, before the
 * runtime resolves its services) is ignored: the boot reconcile reads the
 * then-current snapshot, so nothing it would have done is missed.
 */
const onBuiltinsChanged = (): void => {
	const services = bootedServices;
	if (services === undefined) return;
	Effect.runFork(reconciler.reconcile(services));
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

/** The live areas right now, in registration order. */
export const liveBuiltinAreas = reconciler.live;
