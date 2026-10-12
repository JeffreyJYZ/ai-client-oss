import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	judgeApiVersion,
	judgeEngine,
	parseVersion,
} from "@lib/plugins/version";

describe("parseVersion", () => {
	test("reads major, minor and patch, defaulting missing parts to 0", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseVersion("0.1")).toEqual({ major: 0, minor: 1, patch: 0 });
		expect(parseVersion("2")).toEqual({ major: 2, minor: 0, patch: 0 });
		expect(parseVersion(" 0.2.3 ")).toEqual({ major: 0, minor: 2, patch: 3 });
	});

	test("is null for anything that is not a numeric dotted version", () => {
		expect(parseVersion("")).toBeNull();
		expect(parseVersion("*")).toBeNull();
		expect(parseVersion(">=0.2.3")).toBeNull();
		expect(parseVersion("^1.0")).toBeNull();
		expect(parseVersion("1.x")).toBeNull();
		expect(parseVersion("next")).toBeNull();
	});
});

describe("compareVersions", () => {
	test("orders by major, then minor, then patch", () => {
		const at = (value: string) => {
			const parsed = parseVersion(value);
			if (parsed === null) throw new Error(value);
			return parsed;
		};
		expect(compareVersions(at("1.0.0"), at("1.0.0"))).toBe(0);
		expect(compareVersions(at("0.2.3"), at("0.3.0"))).toBe(-1);
		expect(compareVersions(at("2.0.0"), at("1.9.9"))).toBe(1);
		expect(compareVersions(at("0.2.3"), at("0.2.10"))).toBe(-1);
	});
});

describe("judgeApiVersion", () => {
	test("a different major refuses", () => {
		const verdict = judgeApiVersion("0.1", "1.0");
		expect(verdict.verdict).toBe("refuse");
		expect(verdict.detail).toContain("1.0");
	});

	test("a different minor warns", () => {
		expect(judgeApiVersion("0.1", "0.2").verdict).toBe("warn");
	});

	test("the same major.minor is ok", () => {
		expect(judgeApiVersion("0.1", "0.1").verdict).toBe("ok");
		// Only major and minor matter; a patch difference stays compatible.
		expect(judgeApiVersion("0.1.4", "0.1.9").verdict).toBe("ok");
	});

	test("an unparsable version warns and never refuses", () => {
		expect(judgeApiVersion("0.1", "next").verdict).toBe("warn");
		expect(judgeApiVersion("", "").verdict).toBe("warn");
		expect(judgeApiVersion("0.1", "*").verdict).toBe("warn");
	});
});

describe("judgeEngine", () => {
	test("a blank or `*` requirement accepts any app version", () => {
		expect(judgeEngine("", "0.2.3").verdict).toBe("ok");
		expect(judgeEngine("*", "0.2.3").verdict).toBe("ok");
	});

	test("a satisfied `>=` bound is ok, with or without the operator", () => {
		expect(judgeEngine(">=0.2.3", "0.2.3").verdict).toBe("ok");
		expect(judgeEngine(">=0.2.3", "0.3.0").verdict).toBe("ok");
		expect(judgeEngine("0.2.0", "0.2.3").verdict).toBe("ok");
	});

	test("an unsatisfiable bound refuses", () => {
		const verdict = judgeEngine(">=99.0.0", "0.2.3");
		expect(verdict.verdict).toBe("refuse");
		expect(verdict.detail).toContain("99.0.0");
		expect(verdict.detail).toContain("0.2.3");
	});

	test("an unparsable requirement warns and never refuses", () => {
		expect(judgeEngine("^1.0", "0.2.3").verdict).toBe("warn");
		expect(judgeEngine(">=next", "0.2.3").verdict).toBe("warn");
	});
});
