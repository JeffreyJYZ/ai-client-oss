import { Effect } from "effect";
import { z } from "zod";
import { ChatCompletionsSend, ResponsesSend } from "../types/protocols";

export const parseResponsesSend = (
	obj: unknown,
): Effect.Effect<ResponsesSend, string> =>
	Effect.gen(function* () {
		const parseRes = z.safeParse(ResponsesSend, obj);
		if (!parseRes.success) return yield* Effect.fail(parseRes.error.message);
		return parseRes.data;
	});

export const parseChatCompletionsSend = (
	obj: unknown,
): Effect.Effect<ChatCompletionsSend, string> =>
	Effect.gen(function* () {
		const parseRes = z.safeParse(ChatCompletionsSend, obj);
		if (!parseRes.success) return yield* Effect.fail(parseRes.error.message);
		return parseRes.data;
	});
