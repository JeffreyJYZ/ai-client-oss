import { type ProtocolName, protocolNames } from "@lib/providers";
import type { AttachmentPart } from "@lib/providers/types";
import type { Effect, Option } from "effect";
import { z } from "zod";

const defaultProtocol: ProtocolName = "chatcompletions";

/** Stable id for the seed provider; also the default active pointer. */
export const DEFAULT_PROVIDER_ID = "provider-default";

/**
 * One persisted provider configuration. `models` caches the ids returned by
 * "Fetch models" so a picker can offer them without another round-trip.
 */
export const providerConfigSchema = z.object({
	id: z.string(),
	label: z.string().default(""),
	protocol: z.enum(protocolNames).default(defaultProtocol),
	baseUrl: z.string().default(""),
	apiKey: z.string().default(""),
	model: z.string().default(""),
	models: z.array(z.string()).default([]),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** A fresh, empty provider: only `id` is required, the rest fall to defaults. */
export const emptyProviderConfig = (id: string): ProviderConfig =>
	providerConfigSchema.parse({ id });

/**
 * Canonical persisted settings shape. `src/lib/db` owns this so `lib` never has
 * to depend on `state`; the settings store imports it from `@lib/db`. Defaults
 * seed one empty provider and point `activeProviderId` at it.
 */
export const Settings = z.object({
	providers: z
		.array(providerConfigSchema)
		.default(() => [emptyProviderConfig(DEFAULT_PROVIDER_ID)]),
	activeProviderId: z.string().default(DEFAULT_PROVIDER_ID),
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
	/** Per-conversation system prompt, sent on every request. Blank = none. */
	systemPrompt: z.string().optional(),
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
