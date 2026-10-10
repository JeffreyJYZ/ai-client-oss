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
	/**
	 * Tools sent verbatim on this provider's requests. Per-provider
	 * on/off + result-count carrier; the endpoint's mechanism (see
	 * `searchKindFor`) decides the wire shape, and
	 * `web_search_preview` is OpenAI's marker.
	 */
	tools: z
		.array(
			z.object({
				type: z.string(),
				max_num_results: z.number(),
			}),
		)
		.default([]),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** A fresh, empty provider: only `id` is required, the rest fall to defaults. */
export const emptyProviderConfig = (id: string): ProviderConfig =>
	providerConfigSchema.parse({ id });

/**
 * A saved bundle of provider + model + system prompt, applied in one pick.
 * `providerId` points at a `ProviderConfig`; a dangling pointer is tolerated
 * (applying then only sets the system prompt).
 */
export const profileSchema = z.object({
	id: z.string(),
	name: z.string().default(""),
	providerId: z.string().default(""),
	model: z.string().default(""),
	systemPrompt: z.string().default(""),
});

export type Profile = z.infer<typeof profileSchema>;

/** A fresh, empty profile: only `id` is required, the rest fall to defaults. */
export const emptyProfile = (id: string): Profile =>
	profileSchema.parse({ id });

/**
 * One durable memory note: a fact the model wrote into its reply (stripped
 * from the displayed text before storage, see `lib/memory.ts`) or the user
 * added in Settings. `source` labels who wrote it.
 */
export const memoryNoteSchema = z.object({
	id: z.string(),
	text: z.string(),
	createdAt: z.number(),
	source: z.enum(["model", "user"]),
});

export type MemoryNote = z.infer<typeof memoryNoteSchema>;

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
	/** Saved provider+model+system-prompt bundles; empty until the user adds one. */
	profiles: z.array(profileSchema).default([]),
	/** Durable notes for the whole app, one list sent with every request. */
	memories: z.array(memoryNoteSchema).default([]),
	/** Off = no notes injected into requests and none recorded from replies. */
	memoriesEnabled: z.boolean().default(true),
	/**
	 * Declare the built-in `fetch_url` tool on requests. Off
	 * sends no declaration, so the model cannot call it.
	 */
	fetchToolEnabled: z.boolean().default(true),
	/** A dismissed notice stays dismissed across reloads. */
	dismissedInstallNote: z.boolean().default(false),
	/** Newest release whose update notice the user has dismissed. */
	dismissedUpdateVersion: z.string().default(""),
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
