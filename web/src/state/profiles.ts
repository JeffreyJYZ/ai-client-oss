import type { Profile } from "@lib/db";
import { setSystemPrompt } from "./chat";
import {
	getSettings,
	selectProvider,
	selectVariant,
	updateProvider,
} from "./settings";

/**
 * Applying a profile spans two stores, so the orchestration lives here rather
 * than in either one: `state/settings.ts` must stay free of a chat dependency
 * (its helpers are what everything else builds on) and `state/chat.ts` already
 * imports `settings.ts`, so owning "apply" in either would cycle or split the
 * two halves across modules.
 *
 * Effect: point the active provider at `providerId`, write `model` into that
 * provider, set the active conversation's system prompt, and make the profile's
 * variant the active one. A profile whose variant was deleted clears the
 * pointer rather than keeping whatever variant happened to be active before —
 * the profile names one bundle, not "leave the other half alone".
 */
export const applyProfile = (profile: Profile): void => {
	selectProvider(profile.providerId);
	updateProvider(profile.providerId, { model: profile.model });
	const variantExists = getSettings().variants.some(
		(variant) => variant.id === profile.variantId,
	);
	selectVariant(variantExists ? profile.variantId : "");
	setSystemPrompt(profile.systemPrompt);
};
