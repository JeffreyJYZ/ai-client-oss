import { describe, expect, test } from "bun:test";
import { SendMsg } from "@lib/api";
import { type ProtocolName, protocolNames, providers } from "@lib/providers";
import type { SendCtx } from "@lib/providers/types";
import { Effect } from "effect";

const ctx: SendCtx = { msg: "hi", prev: undefined, apiUrl: "http://x" };

describe("registry", () => {
	test("exposes both protocols", () => {
		expect(protocolNames).toEqual(["responses", "chatcompletions"]);
	});

	test("SendMsg returns the provider's effect for each protocol", () => {
		for (const p of protocolNames) {
			expect(Effect.isEffect(SendMsg(p, ctx))).toBe(true);
		}
	});

	test("accepts an absent prev (first turn)", async () => {
		const exit = await Effect.runPromiseExit(
			providers.responses.parse(providers.responses.template),
		);
		expect(exit._tag).toBe("Success");
	});

	test("SendMsg fails cleanly on an unknown protocol", async () => {
		const exit = await Effect.runPromiseExit(
			SendMsg("nope" as ProtocolName, ctx),
		);
		expect(exit._tag).toBe("Failure");
	});
});
