import { SETTINGS_KEY, Settings, settingsDefaults } from "@lib/db";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";

const parseJson = (raw: string): unknown =>
	Effect.runSync(
		Effect.orElseSucceed(
			Effect.try(() => JSON.parse(raw)),
			() => undefined,
		),
	);

const load = (): Settings => {
	const raw = localStorage.getItem(SETTINGS_KEY);
	if (raw === null) return settingsDefaults();
	const parsed = Settings.safeParse(parseJson(raw));
	return parsed.success ? parsed.data : settingsDefaults();
};

let current: Settings = load();

const listeners = new Set<() => void>();

export const getSettings = (): Settings => current;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const setSettings = (patch: Partial<Settings>): void => {
	const parsed = Settings.safeParse({ ...current, ...patch });
	if (!parsed.success) return;
	current = parsed.data;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
	for (const cb of listeners) cb();
};

export const useSettings = (): Settings =>
	useSyncExternalStore(subscribe, getSettings);
