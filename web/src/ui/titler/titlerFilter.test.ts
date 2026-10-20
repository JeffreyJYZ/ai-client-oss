import { describe, expect, test } from "bun:test";
import { filterTitlerOptions } from "@/ui/titler/titlerFilter";

const entries = [
	{
		key: "",
		label: "Automatic (free)",
		automatic: true,
		saved: false,
		model: "",
		providerId: "",
	},
	{
		key: "or\u0000openrouter/free",
		label: "OpenRouter · openrouter/free",
		automatic: false,
		saved: false,
		model: "openrouter/free",
		providerId: "or",
	},
	{
		key: "or\u0000a-paid-one",
		label: "OpenRouter · a-paid-one",
		automatic: false,
		saved: false,
		model: "a-paid-one",
		providerId: "or",
	},
	{
		key: "oc\u0000beam-free",
		label: "OpenCode · beam-free",
		automatic: false,
		saved: false,
		model: "beam-free",
		providerId: "oc",
	},
	{
		key: "or\u0000removed-model",
		label: "or · removed-model (not in the cached list)",
		automatic: false,
		saved: true,
		model: "removed-model",
		providerId: "or",
	},
];

describe("filterTitlerOptions", () => {
	test("an empty query lists everything", () => {
		expect(filterTitlerOptions(entries, "")).toHaveLength(entries.length);
		expect(filterTitlerOptions(entries, "   ")).toHaveLength(entries.length);
	});

	test("a case-insensitive substring match", () => {
		const result = filterTitlerOptions(entries, "BEAM");
		expect(result.map((entry) => entry.model)).toContain("beam-free");
	});

	test("matches on the model id", () => {
		const result = filterTitlerOptions(entries, "openrouter/free");
		expect(result.map((entry) => entry.model)).toContain("openrouter/free");
	});

	test("matches on the provider label", () => {
		const result = filterTitlerOptions(entries, "opencode");
		expect(result.map((entry) => entry.model)).toContain("beam-free");
	});

	test("the saved override survives a non-matching query", () => {
		const result = filterTitlerOptions(entries, "zzzz-no-match");
		expect(result.map((entry) => entry.saved)).toContain(true);
	});

	test("Automatic is always available", () => {
		const result = filterTitlerOptions(entries, "zzzz-no-match");
		expect(
			result.some((entry) => entry.label.toLowerCase().includes("automatic")),
		).toBe(true);
	});
});
