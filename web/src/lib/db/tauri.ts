import { type Conversation, type Db, settingsDefaults } from "@lib/db/types";
import { Effect } from "effect";

const notImplemented = <A>(): Effect.Effect<A, string> =>
	Effect.fail("tauri storage not implemented");

/**
 * Stub Tauri adapter. The interface compiles and `index.ts` can select it, but
 * the Rust storage command is a separate, later task. `getSettings` returns
 * defaults because its interface has no error channel.
 */
export const tauri: Db = {
	listConversations: () => notImplemented<Conversation[]>(),
	getConversation: () => notImplemented<Conversation | undefined>(),
	upsertConversation: () => notImplemented<void>(),
	deleteConversation: () => notImplemented<void>(),
	getSettings: () => Effect.succeed(settingsDefaults()),
	setSettings: () => notImplemented<void>(),
};
