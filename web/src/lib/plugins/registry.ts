import { PluginFault } from "@lib/plugins/errors";
import { Effect, Option, PubSub, Ref, Scope, Stream } from "effect";

/**
 * The data half of one contribution: what every registry needs to resolve an
 * entry, whatever else the entry carries (spec §3). `id` is unique within a
 * registry, `owner` is the plugin that registered it — the key `ownedBy` and a
 * plugin's disposal use — and the two optional keys are the explicit sort keys.
 */
export interface RegistryEntry {
	readonly id: string;
	readonly owner: string;
	readonly order?: number;
	readonly priority?: number;
}

/**
 * The handle every registration returns (spec §2): plain and synchronous for
 * plugin authors, because registering is synchronous. Disposing it removes
 * exactly that entry, whoever calls it — the plugin, or the `Scope` that owns
 * the plugin's lifetime.
 */
export interface Disposable {
	readonly dispose: () => void;
}

/** A named, ordered collection the host resolves from (spec §2). */
export interface Registry<E extends RegistryEntry> {
	/** Add or replace an entry; the returned handle removes exactly this one. */
	readonly add: (entry: E) => Effect.Effect<Disposable>;
	/** Every entry, in resolution order. */
	readonly entries: () => Effect.Effect<readonly E[]>;
	/** One plugin's entries, in resolution order. */
	readonly ownedBy: (owner: string) => Effect.Effect<readonly E[]>;
	/** A snapshot of `entries()` after every mutation. */
	readonly changes: Stream.Stream<readonly E[]>;
}

/**
 * The one resolution rule (spec §4): explicit `order` ascending, an absent one
 * sorting last; then `priority` descending, so the more important entry wins;
 * then registration order. Computed on read, so a registration only ever has to
 * append or replace one element and no caller can observe a half-sorted list.
 */
const resolveOrder = <E extends RegistryEntry>(
	list: readonly E[],
): readonly E[] =>
	list
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			// Do NOT subtract these: `Infinity - Infinity` is NaN, and `NaN !== 0`
			// is true, so a subtraction here returns NaN and the engine treats the
			// pair as equal — silently skipping the priority tiebreak below for
			// every pair of entries that set no `order` (Task 12 found it).
			const aOrder = a.entry.order ?? Number.POSITIVE_INFINITY;
			const bOrder = b.entry.order ?? Number.POSITIVE_INFINITY;
			if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;
			const priority = (b.entry.priority ?? 0) - (a.entry.priority ?? 0);
			if (priority !== 0) return priority;
			return a.index - b.index;
		})
		.map(({ entry }) => entry);

/**
 * The synchronous mutation seam. `Disposable.dispose` is a plain function for
 * plugin authors, so it cannot yield — and it does not need to: `Ref`'s updates
 * are `Effect.sync` and `PubSub.publishUnsafe` never suspends, so both run under
 * `Effect.runSync` with no services to inherit.
 */
const removeEntry = <E extends RegistryEntry>(
	state: Ref.Ref<readonly E[]>,
	pubsub: PubSub.PubSub<readonly E[]>,
	entry: E,
): void => {
	Effect.runSync(Ref.update(state, (list) => list.filter((e) => e !== entry)));
	PubSub.publishUnsafe(pubsub, resolveOrder(Ref.getUnsafe(state)));
};

/**
 * A registry stores its entries in a `Ref` in registration order and publishes
 * `resolveOrder`'s view of them over a `PubSub`, so `entries()` and `changes`
 * can never disagree (spec §3's `Ref` + snapshot pair).
 *
 * Lifetime is `Scope` (spec §3): `add` registers its own removal as a finalizer
 * on the ambient scope, so closing a plugin's scope removes everything that
 * plugin registered, in reverse order, and a hot reload is that close plus a
 * fresh `setup`. The scope is *optional* here — `add` runs with no ambient scope
 * by adding the entry without a finalizer — because the registry primitive is
 * also used at boot and in tests where no plugin scope exists; the caller that
 * owns a plugin's lifetime (the loader) always provides one, and only that
 * caller can promise a registration will be disposed.
 */
export const makeRegistry = <E extends RegistryEntry>(
	name: string,
): Effect.Effect<Registry<E>> =>
	Effect.gen(function* () {
		const state = yield* Ref.make<readonly E[]>([]);
		const pubsub = yield* PubSub.unbounded<readonly E[]>({ replay: 1 });

		/** Publish the current view; the replay buffer seeds late subscribers. */
		const emit = () => {
			PubSub.publishUnsafe(pubsub, resolveOrder(Ref.getUnsafe(state)));
		};

		const disposable = (entry: E): Disposable => ({
			// Identity, not id: an entry that replaced this one in place must
			// survive this handle's disposal.
			dispose: () => removeEntry(state, pubsub, entry),
		});

		// Seed the stream so a subscriber that arrives before the first add sees
		// the empty registry rather than nothing.
		emit();

		const add = (entry: E): Effect.Effect<Disposable> =>
			Effect.gen(function* () {
				const duplicate = yield* Ref.modify(
					state,
					(list): [boolean, readonly E[]] => {
						const at = list.findIndex((e) => e.id === entry.id);
						if (at < 0) return [false, [...list, entry]];
						const next = list.slice();
						next[at] = entry;
						return [true, next];
					},
				);
				emit();

				const handle = disposable(entry);
				if (duplicate) {
					yield* Effect.logWarning(
						new PluginFault({
							detail: `registry "${name}" already holds a contribution with id "${entry.id}"; it was replaced in place`,
							pluginId: entry.owner,
						}),
					);
				}

				const scope = yield* Effect.serviceOption(Scope.Scope);
				if (Option.isSome(scope)) {
					yield* Scope.addFinalizer(
						scope.value,
						Effect.sync(() => handle.dispose()),
					);
				}
				return handle;
			});

		return {
			add,
			entries: () => Ref.get(state).pipe(Effect.map(resolveOrder)),
			ownedBy: (owner: string) =>
				Ref.get(state).pipe(
					Effect.map((list) =>
						resolveOrder(list.filter((entry) => entry.owner === owner)),
					),
				),
			changes: Stream.fromPubSub(pubsub),
		} satisfies Registry<E>;
	});
