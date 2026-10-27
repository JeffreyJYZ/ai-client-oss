import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	emptyProfile,
	emptyProviderConfig,
	emptyVariant,
	type Settings,
} from "@lib/db";
import { applyProfile } from "@/state/profiles";
import { addProfile, getSettings, setSettings } from "@/state/settings";

/**
 * A profile is the request-side bundle: provider + model + system prompt +
 * variant. These drive the real settings store (no DOM, no mock), and restore
 * it afterwards because the store is a process-wide module variable.
 */

let snapshot: Settings;

beforeEach(() => {
	snapshot = getSettings();
	setSettings({
		providers: [emptyProviderConfig("p1"), emptyProviderConfig("p2")],
		activeProviderId: "p1",
		variants: [emptyVariant("v1"), emptyVariant("v2")],
		activeVariantId: "",
		profiles: [],
	});
});

afterEach(() => {
	setSettings(snapshot);
});

describe("applyProfile", () => {
	test("applies the provider, its model and the profile's variant", () => {
		applyProfile({
			...emptyProfile("profile"),
			providerId: "p2",
			model: "model-b",
			variantId: "v2",
		});

		const settings = getSettings();
		expect(settings.activeProviderId).toBe("p2");
		expect(
			settings.providers.find((provider) => provider.id === "p2")?.model,
		).toBe("model-b");
		expect(settings.activeVariantId).toBe("v2");
	});

	test("a profile without a variant clears the active one", () => {
		setSettings({ activeVariantId: "v1" });
		applyProfile({ ...emptyProfile("profile"), variantId: "" });

		expect(getSettings().activeVariantId).toBe("");
	});

	test("a variant deleted since the profile was saved leaves none active", () => {
		setSettings({ activeVariantId: "v1" });
		applyProfile({ ...emptyProfile("profile"), variantId: "deleted" });

		expect(getSettings().activeVariantId).toBe("");
	});
});

describe("addProfile", () => {
	test("starts from the variant already in use", () => {
		setSettings({ activeVariantId: "v2" });
		const id = addProfile();

		const added = getSettings().profiles.find((profile) => profile.id === id);
		expect(added?.variantId).toBe("v2");
	});
});
