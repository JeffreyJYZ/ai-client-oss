import {
	db,
	emptyProfile,
	emptyProviderConfig,
	type Profile,
	type ProviderConfig,
	Settings,
	settingsDefaults,
} from "@lib/db";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";

/**
 * In-memory snapshot. Seeded with defaults so the app boots before hydration
 * (and if hydration fails) — `db` owns the persistence, this store is a
 * synchronous read cache over it.
 */
let current: Settings = settingsDefaults();

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

export const getSettings = (): Settings => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

/** Persistence is best-effort: a failure is logged, never thrown at callers. */
const persist = (patch: Partial<Settings>): void => {
	Effect.runFork(
		Effect.catch(db.setSettings(patch), (error) =>
			Effect.logError(`failed to persist settings: ${error}`),
		),
	);
};

/**
 * Write-through: update memory + notify synchronously, then persist. The store
 * validates the merged result; an invalid patch is dropped silently so the
 * adapter only ever sees a valid patch.
 */
export const setSettings = (patch: Partial<Settings>): void => {
	const parsed = Settings.safeParse({ ...current, ...patch });
	if (!parsed.success) return;
	current = parsed.data;
	notify();
	persist(patch);
};

// Hydrate from `db` on module load; until it resolves `current` stays defaults.
Effect.runFork(
	Effect.flatMap(db.getSettings(), (settings) =>
		Effect.sync(() => {
			current = settings;
			notify();
		}),
	),
);

export const useSettings = (): Settings =>
	useSyncExternalStore(subscribe, getSettings);

/** The provider the active pointer resolves to, or `undefined` if it dangles. */
export const getActiveProvider = (): ProviderConfig | undefined =>
	current.providers.find(
		(provider) => provider.id === current.activeProviderId,
	);

const newProviderId = (): string => `provider-${crypto.randomUUID()}`;

/** Append a fresh provider, make it active, and return its id. */
export const addProvider = (label = ""): string => {
	const provider: ProviderConfig = {
		...emptyProviderConfig(newProviderId()),
		label,
	};
	setSettings({
		providers: [...current.providers, provider],
		activeProviderId: provider.id,
	});
	return provider.id;
};

/** Patch one provider's fields; `id` is immutable and an unknown id is a no-op. */
export const updateProvider = (
	id: string,
	patch: Partial<Omit<ProviderConfig, "id">>,
): void => {
	setSettings({
		providers: current.providers.map((provider) =>
			provider.id === id ? { ...provider, ...patch } : provider,
		),
	});
};

/** Remove a provider; if it was active the pointer moves to the first survivor. */
export const removeProvider = (id: string): void => {
	const providers = current.providers.filter((provider) => provider.id !== id);
	setSettings({
		providers,
		...(current.activeProviderId === id
			? { activeProviderId: providers[0]?.id ?? "" }
			: {}),
	});
};

/** Point the active pointer at `id`; an unknown id is a no-op. */
export const selectProvider = (id: string): void => {
	if (!current.providers.some((provider) => provider.id === id)) return;
	setSettings({ activeProviderId: id });
};

const newProfileId = (): string => `profile-${crypto.randomUUID()}`;

/**
 * Append a fresh profile and return its id. Defaults its `providerId` to the
 * active provider so a new profile starts pointing at something real.
 */
export const addProfile = (providerId = current.activeProviderId): string => {
	const profile: Profile = { ...emptyProfile(newProfileId()), providerId };
	setSettings({ profiles: [...current.profiles, profile] });
	return profile.id;
};

/** Patch one profile's fields; `id` is immutable and an unknown id is a no-op. */
export const updateProfile = (
	id: string,
	patch: Partial<Omit<Profile, "id">>,
): void => {
	setSettings({
		profiles: current.profiles.map((profile) =>
			profile.id === id ? { ...profile, ...patch } : profile,
		),
	});
};

/** Remove a profile; an unknown id is a no-op. */
export const removeProfile = (id: string): void => {
	setSettings({
		profiles: current.profiles.filter((profile) => profile.id !== id),
	});
};
