import { db } from "@lib/db";
import { conversationSchema, Settings } from "@lib/db/types";
import { Effect } from "effect";
import { z } from "zod";

/** Version of the export file shape; bump only with a migration. */
export const BACKUP_VERSION = 1;

export const backupSchema = z.object({
	version: z.literal(BACKUP_VERSION),
	exportedAt: z.string(),
	settings: Settings,
	conversations: z.array(conversationSchema),
});
export type Backup = z.infer<typeof backupSchema>;

/** Read the whole store into a serialisable backup. */
export const exportBackup: () => Effect.Effect<Backup, string> = () =>
	Effect.map(
		Effect.all([db.getSettings(), db.listConversations()]),
		([settings, conversations]) => ({
			version: BACKUP_VERSION,
			exportedAt: new Date().toISOString(),
			settings,
			conversations,
		}),
	);

/**
 * Validate + write a backup: replace settings, upsert conversations
 * (additive — never deletes anything). Fails with a readable message
 * on a bad payload and leaves storage untouched.
 */
export const importBackup = (
	raw: unknown,
): Effect.Effect<{ readonly conversations: number }, string> =>
	Effect.gen(function* () {
		const parsed = backupSchema.safeParse(raw);
		if (!parsed.success) {
			return yield* Effect.fail("not a valid ai-client backup file");
		}
		const { settings, conversations } = parsed.data;
		yield* db.setSettings(settings);
		yield* Effect.forEach(conversations, (conversation) =>
			db.upsertConversation(conversation),
		);
		return { conversations: conversations.length };
	});
