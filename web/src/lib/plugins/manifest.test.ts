import { describe, expect, test } from "bun:test";
import { Settings } from "@lib/db/types";
import { manifestSchema } from "@lib/plugins/manifest";

describe("manifestSchema", () => {
	test("accepts a minimal manifest and defaults entry and capabilities", () => {
		const m = manifestSchema.parse({
			id: "a.b",
			name: "B",
			version: "1.0.0",
			apiVersion: "0.1",
		});
		expect(m.entry).toBe("main.js");
		expect(m.capabilities).toEqual([]);
	});
	test("rejects a missing id, an unknown capability and a blank version", () => {
		expect(
			manifestSchema.safeParse({ name: "B", version: "1", apiVersion: "0.1" })
				.success,
		).toBe(false);
		expect(
			manifestSchema.safeParse({
				id: "a",
				name: "B",
				version: "1",
				apiVersion: "0.1",
				capabilities: ["teleport"],
			}).success,
		).toBe(false);
		expect(
			manifestSchema.safeParse({
				id: "a",
				name: "B",
				version: "",
				apiVersion: "0.1",
			}).success,
		).toBe(false);
	});
});

describe("Settings", () => {
	test("a blob written before plugins existed still parses", () => {
		const parsed = Settings.parse({ providers: [], activeProviderId: "" });
		expect(parsed.pluginsEnabled).toBe(false);
		expect(parsed.plugins).toEqual([]);
	});
	test("round-trips plugin state with unknown per-plugin data", () => {
		const parsed = Settings.parse({
			plugins: [
				{
					id: "a.b",
					enabled: true,
					version: "1.0.0",
					capabilities: [],
					data: { any: { shape: 1 } },
				},
			],
		});
		expect(parsed.plugins[0]?.data).toEqual({ any: { shape: 1 } });
	});
	test("a stored provider naming a protocol only a plugin can register still parses", () => {
		// The field was `z.enum(protocolNames)`; a name no built-in ships is now
		// valid, so a plugin protocol in a stored blob must survive the round
		// trip rather than fail the whole `Settings` object (spec §13).
		const parsed = Settings.parse({
			providers: [{ id: "p", protocol: "some-plugin-thing" }],
		});
		expect(parsed.providers[0]?.protocol).toBe("some-plugin-thing");
		expect(parsed.providers[0]?.id).toBe("p");
	});
});
