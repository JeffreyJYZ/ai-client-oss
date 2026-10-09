import { expect, test } from "bun:test";
import { providers } from "@lib/providers";
import type { SendCtx } from "@lib/providers/types";

const ctx = (msg: string): SendCtx => ({
	msg,
	prev: undefined,
	apiUrl: "http://x",
});

test("responses body appends a user input_text turn", () => {
	const body = providers.responses.buildRequest(
		providers.responses.template,
		ctx("hello"),
	) as {
		model: string;
		input: { role: string; content: { type: string; text: string }[] }[];
		stream: boolean;
	};
	expect(body.model).toBe("");
	expect(body.stream).toBe(true);
	expect(body.input.at(-1)).toEqual({
		role: "user",
		content: [{ type: "input_text", text: "hello" }],
	});
});

test("chatcompletions body appends a user message", () => {
	const body = providers.chatcompletions.buildRequest(
		providers.chatcompletions.template,
		ctx("hello"),
	) as {
		model: string;
		messages: { role: string; content: string }[];
	};
	expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello" });
});
