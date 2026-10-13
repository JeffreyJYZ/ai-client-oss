import { PluginFault } from "@lib/plugins/errors";
import { type Host, HostServices } from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import type { Provider } from "@lib/providers/types";
import { Effect, Option } from "effect";

/**
 * The provider registry (spec §5). A protocol is the existing `Provider<Send>`
 * contract under a name — the contract is unchanged; what changes is that the
 * set of names is now runtime data, so a plugin can add one this build has
 * never heard of (spec §13's stored-protocol widening is the other half of
 * this).
 *
 * Storage is the host's own `providers` registry (`HostServices`), so a
 * protocol registered here is owned and disposed by the registering plugin's
 * `Scope`, the same lifetime every other contribution has. Only this module
 * writes providers, which is what makes the narrowing in `asProviderEntry`
 * sound.
 */

/**
 * The contract with its wire-body type erased. `Send` is existential across the
 * registry — one collection holds `responses`, `chatcompletions` and a
 * plugin's own body type — and `Provider<Send>` is invariant in `Send` (each
 * member takes `Send` as a parameter), so no single `Send` type can hold all
 * three. Callers that need the concrete body re-narrow, exactly as
 * `state/chat.ts` already does.
 */
// biome-ignore lint/suspicious/noExplicitAny: `Send` is existential across the registry, see above
export type AnyProvider = Provider<any>;

/**
 * The entry a provider is stored as (spec §2): `RegistryEntry`'s identity and
 * ownership plus the protocol contract. `id` is the wire name, so a provider
 * resolves by name and registration order is resolution order.
 */
export type ProviderEntry = RegistryEntry & AnyProvider;

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/**
 * A registration refused for a bad value is a logged `PluginFault`, never a
 * throw (spec §9): one protocol is dropped, the plugin and the app keep
 * running.
 */
const refuse = (detail: string, pluginId?: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

/**
 * Register `provider` under `name` through `host`, first wins (spec §5) — the
 * same rule the tool registry follows. Built-ins register at boot, before any
 * plugin loads, so a plugin's same-name protocol is refused with a
 * `PluginFault` and the built-in stays the one that resolves: a plugin cannot
 * silently displace a protocol an existing provider's `Settings` already
 * names. `pluginId` names the refusing plugin in that fault; the built-in
 * registrar omits it, since it registers first and can never collide.
 */
export const registerProvider = (
	host: Host,
	name: string,
	provider: AnyProvider,
	pluginId?: string,
): Disposable => {
	// Read defensively: the caller is untyped JavaScript at this boundary.
	const named = typeof name === "string" ? name.trim() : "";
	if (named === "") {
		refuse("a protocol was registered without a name", pluginId);
		return noopDisposable;
	}
	const taken = Effect.runSync(host.providers.entries()).some(
		(entry) => entry.id === named,
	);
	if (taken) {
		refuse(
			`a protocol named "${named}" is already registered; the later registration was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	if (typeof provider?.send !== "function") {
		refuse(
			`the protocol "${named}" has no callable \`send\`; it was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	const entry: Omit<ProviderEntry, "owner"> = { id: named, ...provider };
	return host.providers.register(entry);
};

/**
 * The registry stores `ProviderEntry`s, but `HostServices.providers` is typed
 * as the bare `RegistryEntry` (Task 3 left the non-`ui` kinds untyped). Only
 * `registerProvider` writes providers, so the narrowing is sound.
 */
const asProviderEntry = (entry: RegistryEntry): ProviderEntry =>
	entry as ProviderEntry;

/**
 * The protocol registered as `name`, or `none` (spec §5). `SendMsg` maps
 * `none` to a failed turn, so a caller never dereferences an absent provider —
 * the `TypeError` on `undefined.send` the old static lookup could produce.
 *
 * The **entry**, not the bare contract: it carries `owner`, the plugin that
 * registered the protocol, so a caller that isolates a fault can name the
 * plugin as the tool and pipeline seams already do.
 */
export const resolveProvider = (
	name: string,
): Effect.Effect<Option.Option<ProviderEntry>, never, HostServices> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.map(services.providers.entries(), (entries) => {
			const found = entries.find((entry) => entry.id === name);
			return found === undefined
				? Option.none<ProviderEntry>()
				: Option.some<ProviderEntry>(asProviderEntry(found));
		}),
	);

/**
 * Every registered protocol name, in resolution order (spec §5). The registry
 * is the only source: a plugin's protocol is listed without any page knowing
 * its name.
 */
export const listProtocols = (): Effect.Effect<
	readonly string[],
	never,
	HostServices
> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.map(services.providers.entries(), (entries) =>
			entries.map((entry) => entry.id),
		),
	);

/**
 * {@link resolveProvider} read synchronously off the app's one runtime. A
 * synchronous caller cannot yield — `state/chat.ts`'s `send` builds the request
 * body it forks with, and the Settings picker renders during React's own
 * render pass — so the read is bridged here rather than pushed into an Effect
 * that would change when the optimistic rows appear.
 *
 * The runtime's layer is built before the first render (`main.tsx` awaits
 * `runtime.runPromise`), so with the context cached this has no async boundary
 * and never throws `AsyncFiberError`.
 */
export const resolveProviderSync = (
	name: string,
): Option.Option<ProviderEntry> => runtime.runSync(resolveProvider(name));

/**
 * Resolve a protocol or fail with one readable sentence (spec §5). This is the
 * **single** resolve-or-fail seam: `SendMsg` and the models helpers both call
 * it, so the failure sentence cannot drift into two spellings, and a name no
 * protocol answers to is a failed turn rather than a `TypeError` on an absent
 * provider.
 *
 * Returns the {@link ProviderEntry}, so a caller that isolates a fault has the
 * registering plugin's `owner` to name in it, alongside the protocol.
 */
export const requireProvider = (
	protocol: string,
): Effect.Effect<ProviderEntry, string, HostServices> =>
	Effect.gen(function* () {
		const provider = yield* resolveProvider(protocol);
		if (Option.isNone(provider)) {
			return yield* Effect.fail(`unknown protocol: ${protocol}`);
		}
		return provider.value;
	});

/** The registered protocol names, read synchronously (see {@link resolveProviderSync}). */
export const protocolNames = (): readonly string[] =>
	runtime.runSync(listProtocols());
