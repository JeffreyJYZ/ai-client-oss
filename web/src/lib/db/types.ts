import { type ProtocolName, protocolNames } from "@lib/providers";
import type { AttachmentPart } from "@lib/providers/types";
import type { Effect, Option } from "effect";
import { z } from "zod";

const defaultProvider: ProtocolName = "responses";

/**
 * Canonical persisted settings shape. `src/lib/db` owns this so `lib` never has
 * to depend on `state`; the settings store imports it from `@lib/db`.
 */
export const Settings = z.object({
	provider: z.enum(protocolNames).default(defaultProvider),
	baseUrl: z.string().default(""),
	apiKey: z.string().default(""),
	model: z.string().default(""),
	tools: z
		.array(
			z.object({
				type: z.string(),
				max_num_results: z.number(),
			}),
		)
		.default([]),
});

export type Settings = z.infer<typeof Settings>;

export const settingsDefaults = (): Settings => Settings.parse({});

/** Canonical persisted chat message shape (was `state/chat.ts`). */
export const chatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "error"]),
	text: z.string(),
	reasoning: z.string().optional(),
	parts: z.array(z.custom<AttachmentPart>()).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Canonical persisted conversation shape. */
export const conversationSchema = z.object({
	id: z.string(),
	title: z.string(),
	messages: z.array(chatMessageSchema),
	createdAt: z.number(),
	updatedAt: z.number(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export interface Db {
	listConversations(): Effect.Effect<Conversation[], string>;
	getConversation(
		id: string,
	): Effect.Effect<Option.Option<Conversation>, string>;
	upsertConversation(c: Conversation): Effect.Effect<void, string>;
	deleteConversation(id: string): Effect.Effect<void, string>;
	getSettings(): Effect.Effect<Settings>;
	setSettings(patch: Partial<Settings>): Effect.Effect<void, string>;
}
