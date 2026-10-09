import {
	type Conversation,
	conversationSchema,
	type Db,
	Settings,
	settingsDefaults,
} from "@lib/db/types";
import { invoke } from "@tauri-apps/api/core";
import { Effect, Option } from "effect";

/**
 * Invoke one Rust storage command, mapping any rejection to a typed `string`
 * error and leaving the JSON shapes opaque (Rust stores raw strings).
 */
const call = <A>(
	command: string,
	args?: Record<string, unknown>,
): Effect.Effect<A, string> =>
	Effect.tryPromise({
		try: () => invoke<A>(command, args),
		catch: (cause) => String(cause),
	});

/** Parse a stored JSON string, degrading a malformed payload to `undefined`. */
const parseJson = (raw: string): Effect.Effect<unknown> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: () => "invalid json",
		}),
		() => undefined,
	);

/** Validate one stored conversation, dropping anything unparseable. */
const parseConversation = (
	raw: string,
): Effect.Effect<Option.Option<Conversation>> =>
	Effect.map(parseJson(raw), (data) => {
		const parsed = conversationSchema.safeParse(data);
		return parsed.success ? Option.some(parsed.data) : Option.none();
	});

const listConversations = (): Effect.Effect<Conversation[], string> =>
	Effect.gen(function* () {
		const rows = yield* call<string[]>("db_list_conversations");
		const parsed = yield* Effect.forEach(rows, parseConversation);
		return parsed.flatMap((conversation) => Option.toArray(conversation));
	});

const getConversation = (
	id: string,
): Effect.Effect<Option.Option<Conversation>, string> =>
	Effect.gen(function* () {
		const raw = yield* call<string | null>("db_get_conversation", { id });
		if (raw === null) return Option.none();
		return yield* parseConversation(raw);
	});

const upsertConversation = (c: Conversation): Effect.Effect<void, string> =>
	call<void>("db_upsert_conversation", { id: c.id, json: JSON.stringify(c) });

const deleteConversation = (id: string): Effect.Effect<void, string> =>
	call<void>("db_delete_conversation", { id });

const getSettings = (): Effect.Effect<Settings> =>
	Effect.orElseSucceed(
		Effect.gen(function* () {
			const raw = yield* call<string | null>("db_get_settings");
			if (raw === null) return settingsDefaults();
			const data = yield* parseJson(raw);
			const parsed = Settings.safeParse(data);
			return parsed.success ? parsed.data : settingsDefaults();
		}),
		() => settingsDefaults(),
	);

const setSettings = (patch: Partial<Settings>): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		const current = yield* getSettings();
		const parsed = Settings.safeParse({ ...current, ...patch });
		if (!parsed.success) return yield* Effect.fail("invalid settings");
		return yield* call<void>("db_set_settings", {
			json: JSON.stringify(parsed.data),
		});
	});

export const tauri: Db = {
	listConversations,
	getConversation,
	upsertConversation,
	deleteConversation,
	getSettings,
	setSettings,
};
