import type { Profile } from "@lib/db";
import { setSystemPrompt } from "./chat";
import { selectProvider, updateProvider } from "./settings";

/**
 * Applying a profile spans two stores, so the orchestration lives here rather
 * than in either one: `state/settings.ts` must stay free of a chat dependency
 * (its helpers are what everything else builds on) and `state/chat.ts` already
 * imports `settings.ts`, so owning "apply" in either would cycle or split the
 * two halves across modules.
 *
 * Effect: point the active provider at `providerId`, write `model` into that
 * provider, and set the active conversation's system prompt.
 */
export const applyProfile = (profile: Profile): void => {
	selectProvider(profile.providerId);
	updateProvider(profile.providerId, { model: profile.model });
	setSystemPrompt(profile.systemPrompt);
};
