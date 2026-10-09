import { type ProtocolName, protocolNames } from "@lib/providers";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { z } from "zod";

const STORAGE_KEY = "ai-client.settings";

const defaultProvider: ProtocolName = "responses";

export const Settings = z.object({
	provider: z.enum(protocolNames).default(defaultProvider),
	baseUrl: z.string().default(""),
	apiKey: z.string().default(""),
	model: z.string().default(""),
	tools: z
		.array(
			z.object({
				type: z.string(),
				max_num_results: z.number(),
			}),
		)
		.default([]),
});

export type Settings = z.infer<typeof Settings>;

const defaults = (): Settings => Settings.parse({});

const parseJson = (raw: string): unknown =>
	Effect.runSync(
		Effect.orElseSucceed(
			Effect.try(() => JSON.parse(raw)),
			() => undefined,
		),
	);

const load = (): Settings => {
	const raw = localStorage.getItem(STORAGE_KEY);
	if (raw === null) return defaults();
	const parsed = Settings.safeParse(parseJson(raw));
	return parsed.success ? parsed.data : defaults();
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
	localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
	for (const cb of listeners) cb();
};

export const useSettings = (): Settings =>
	useSyncExternalStore(subscribe, getSettings);
