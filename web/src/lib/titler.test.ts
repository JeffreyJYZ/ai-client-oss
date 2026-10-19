import { describe, expect, test } from "bun:test";
import { emptyProviderConfig, type ProviderConfig } from "@lib/db/types";
import {
	cleanTitle,
	resolveTitlerModel,
	TITLER_MAX_TITLE_LENGTH,
	TITLER_PROMPT,
} from "./titler";

const OPENCODE_URL = "https://opencode.ai/zen/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** A stored provider with only the fields a case cares about set. */
const provider = (
	id: string,
	overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({ ...emptyProviderConfig(id), ...overrides });

describe("resolveTitlerModel", () => {
	test("an opencode provider with a key on desktop resolves to its free lane", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "oc",
			model: "step-5-preview-free",
		});
	});

	test("an opencode provider with an EMPTY key resolves to nothing", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "   " })],
		};
		expect(resolveTitlerModel(settings, true)).toBeUndefined();
	});

	test("the opencode lane is not chosen on web, where its endpoint refuses the preflight", () => {
		const settings = {
			providers: [provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, false)).toBeUndefined();
	});

	test("no opencode provider falls back to an OpenRouter free model", () => {
		const settings = {
			providers: [provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" })],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "or",
			model: "openrouter/free",
		});
	});

	test("an explicit Settings.titler override wins over the rule", () => {
		const settings = {
			providers: [
				provider("oc", { baseUrl: OPENCODE_URL, apiKey: "key" }),
				provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" }),
			],
			titler: { providerId: "chosen", model: "chosen-model" },
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "chosen",
			model: "chosen-model",
		});
	});

	test("the free lane is used only while the cached model list still carries it", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-flash", "step-5-preview-free"],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toEqual({
			providerId: "oc",
			model: "step-5-preview-free",
		});
	});

	test("a free id the cached list no longer carries falls through to OpenRouter", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-flash", "glm-5.3"],
				}),
				provider("or", { baseUrl: OPENROUTER_URL, apiKey: "key" }),
			],
		};
		const resolved = resolveTitlerModel(settings, true);
		expect(resolved).toEqual({
			providerId: "or",
			model: "openrouter/free",
		});
		expect(resolved?.model).not.toBe("step-5-preview-free");
	});

	test("a free id the cached list no longer carries never degrades to a paid call", () => {
		const settings = {
			providers: [
				provider("oc", {
					baseUrl: OPENCODE_URL,
					apiKey: "key",
					models: ["deepseek-v4-pro"],
				}),
			],
		};
		expect(resolveTitlerModel(settings, true)).toBeUndefined();
	});
});

describe("cleanTitle", () => {
	test("strips a Title: prefix, wrapping quotes, markdown and a trailing newline", () => {
		expect(cleanTitle('Title: "**A Small Model Picks a Subject**"\n')).toBe(
			"A Small Model Picks a Subject",
		);
		expect(cleanTitle("### A Heading\n")).toBe("A Heading");
	});

	test("an empty reply cleans to an empty title", () => {
		expect(cleanTitle("   \n")).toBe("");
	});

	test("caps the length", () => {
		expect(cleanTitle("w".repeat(TITLER_MAX_TITLE_LENGTH + 25))).toHaveLength(
			TITLER_MAX_TITLE_LENGTH,
		);
	});

	test("strips decoration before the length cap", () => {
		const wrapped = `**${"w".repeat(TITLER_MAX_TITLE_LENGTH + 25)}**`;
		const cleaned = cleanTitle(wrapped);
		expect(cleaned).toHaveLength(TITLER_MAX_TITLE_LENGTH);
		expect(cleaned).not.toContain("*");
	});
});

describe("TITLER_PROMPT", () => {
	test("asks for a title and nothing else", () => {
		expect(TITLER_PROMPT.toLowerCase()).toContain("title");
		expect(TITLER_PROMPT).not.toBe("");
	});
});
