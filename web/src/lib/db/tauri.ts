import { readSettings } from "@lib/db/read";
import {
	type Conversation,
	conversationSchema,
	type Db,
	REJECTED_SETTINGS_MESSAGE,
	Settings,
	settingsDefaults,
} from "@lib/db/types";
import { invoke } from "@tauri-apps/api/core";
import { Effect, Option } from "effect";

/**
 * Raw text of the last stored blob that failed to parse, or `none` when the
 * store is readable. Set by a failed {@link getSettings}, cleared by a
 * successful read, a successful write, or {@link resetRejectedSettings}. This
 * is the whole preservation mechanism: while it is `some`, {@link setSettings}
 * refuses, so the Rust side's `settings.json` is simply never overwritten.
 */
let rejected: Option.Option<string> = Option.none();

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
			const read = yield* readSettings(raw);
			if (read.kind === "rejected") {
				// Unreadable or unmigratable: keep the raw text so a write can
				// refuse, and run on in-memory defaults meanwhile. The stored
				// file is left untouched (spec §13).
				rejected = Option.some(read.raw);
				return settingsDefaults();
			}
			rejected = Option.none();
			return read.settings;
		}),
		() => settingsDefaults(),
	);

const rejectedSettings = (): Effect.Effect<Option.Option<string>> =>
	Effect.sync(() => rejected);

const resetRejectedSettings = (): Effect.Effect<void> =>
	Effect.sync(() => {
		rejected = Option.none();
	});

const setSettings = (patch: Partial<Settings>): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		if (Option.isSome(rejected)) {
			return yield* Effect.fail(REJECTED_SETTINGS_MESSAGE);
		}
		const current = yield* getSettings();
		const parsed = Settings.safeParse({ ...current, ...patch });
		if (!parsed.success) return yield* Effect.fail("invalid settings");
		yield* call<void>("db_set_settings", {
			json: JSON.stringify(parsed.data),
		});
		// The store now holds valid settings, so nothing is outstanding.
		rejected = Option.none();
	});

export const tauri: Db = {
	listConversations,
	getConversation,
	upsertConversation,
	deleteConversation,
	getSettings,
	rejectedSettings,
	resetRejectedSettings,
	setSettings,
};
