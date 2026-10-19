import { DATA_VERSION } from "@lib/db/migrate";
import type { MemoryEntry } from "@lib/memoryNotes";
import { pluginStateSchema } from "@lib/plugins/manifest";
import type { ProtocolName } from "@lib/providers";
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
	/**
	 * Wire protocol name. A string, not an enum: protocols a plugin registers
	 * cannot be enumerated when this schema is defined. Defaulted and then
	 * caught so a missing value takes the default and a wrong-typed one
	 * degrades to it for *this provider only* (`.catch`) instead of failing the
	 * whole `Settings` object — a whole-object failure is what triggers the
	 * defaults path (spec §13).
	 */
	protocol: z.string().default(defaultProtocol).catch(defaultProtocol),
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
 * One entry of the note store (`lib/memoryNotes.ts`) as persisted. Annotated
 * with T1's `MemoryEntry`, so a renamed or retyped field here is a compile
 * error; a field this schema does not declare would instead be *stripped* at
 * parse time, so a round-trip test in `migrate.test.ts` pins the full key set
 * (five tasks consume `MemoryEntry` directly). Named `memoryEntrySchema`
 * because `memoryNoteSchema` above is the legacy `{id, text, createdAt,
 * source}` shape, which stays (the legacy array keeps being written).
 */
// The schema's INPUT is `unknown` because `history` is defaulted below — a stored
// entry may legitimately omit it. Its OUTPUT stays pinned to `MemoryEntry`, which
// is what five later tasks consume, so a field rename or retype is still a compile
// error.
export const memoryEntrySchema: z.ZodType<MemoryEntry, unknown> = z.object({
	id: z.string(),
	content: z.string(),
	updatedAt: z.number(),
	/** Present = soft-deleted; the UI and `memory_list` filter on it. */
	deletedAt: z.number().optional(),
	/**
	 * Previous contents, newest last. Defaulted to none: a note that carries no
	 * history has no revisions to lose, so `[]` is exact for it, whereas requiring
	 * the field turns one omitted array into the whole settings blob being
	 * unreadable (every write refused) rather than degrading to the right answer.
	 * `id`/`content`/`updatedAt` stay required, so real corruption is rejected.
	 */
	history: z
		.array(
			z.object({
				content: z.string(),
				at: z.number(),
			}),
		)
		.default([]),
});

/**
 * Canonical persisted settings shape. `src/lib/db` owns this so `lib` never has
 * to depend on `state`; the settings store imports it from `@lib/db`. Defaults
 * seed one empty provider and point `activeProviderId` at it.
 */
export const Settings = z.object({
	/**
	 * Persisted schema version. A blob written before the field existed reads
	 * as {@link DATA_VERSION}; `migrateSettings` carries any older value up
	 * before this schema sees it.
	 */
	dataVersion: z.number().default(DATA_VERSION),
	providers: z
		.array(providerConfigSchema)
		.default(() => [emptyProviderConfig(DEFAULT_PROVIDER_ID)]),
	activeProviderId: z.string().default(DEFAULT_PROVIDER_ID),
	/** Saved provider+model+system-prompt bundles; empty until the user adds one. */
	profiles: z.array(profileSchema).default([]),
	/** Durable notes for the whole app, one list sent with every request. */
	memories: z.array(memoryNoteSchema).default([]),
	/**
	 * The note store (see `lib/memoryNotes.ts`): one list, with a
	 * soft-deleted entry marked by `deletedAt` rather than held in a
	 * second array. Additive and optional on disk — a blob without
	 * it reads as no notes, and an older app ignores it — so nothing
	 * is required to migrate on its own account; `db/migrate.ts` only
	 * seeds it from the legacy `memories` array.
	 */
	memoryNotes: z.array(memoryEntrySchema).default([]),
	/** Off = no notes injected into requests and none recorded from replies. */
	memoriesEnabled: z.boolean().default(true),
	/**
	 * Declare the built-in `fetch_url` tool on requests. Off
	 * sends no declaration, so the model cannot call it.
	 */
	fetchToolEnabled: z.boolean().default(true),
	/**
	 * TinyFish API key (agent.tinyfish.ai/api-keys). With a
	 * key set, search and page fetch run through TinyFish's
	 * free daily allowance; blank sends no `web_search`
	 * declaration and fetches with the app's own transport
	 * only.
	 */
	tinyfishApiKey: z.string().default(""),
	/** A dismissed notice stays dismissed across reloads. */
	dismissedInstallNote: z.boolean().default(false),
	/** Newest release whose update notice the user has dismissed. */
	dismissedUpdateVersion: z.string().default(""),
	/**
	 * Master switch for the plugin subsystem, default off. With it off
	 * nothing loads and the app behaves exactly as it did before the
	 * feature existed.
	 */
	pluginsEnabled: z.boolean().default(false),
	/**
	 * Per-plugin persisted state: the enable flag, the manifest's
	 * version and declared capabilities at enable time, and the
	 * plugin's own `data`, which rides `settings.json` and every
	 * backup untouched.
	 */
	plugins: z.array(pluginStateSchema).default([]),
	/**
	 * Per-built-in-area on/off state, plus a per-contribution drill-down
	 * (`{ [areaId]: { enabled?, contributions?: { [contributionId]: boolean } } }`).
	 * **Additive and optional: absent means every area and every contribution is
	 * on**, so there is no migration and an older app opening this data ignores
	 * the field entirely. An id that no longer exists is likewise ignored — the
	 * store neither reads it as state nor prunes it — which makes a renamed
	 * built-in contribution's stale state harmless.
	 */
	builtins: z
		.record(
			z.string(),
			z.object({
				enabled: z.boolean().optional(),
				contributions: z.record(z.string(), z.boolean()).optional(),
			}),
		)
		.optional(),
	/**
	 * The user's explicit titler model choice, which wins over the
	 * free-by-default rule (`lib/titler.ts`). Both fields are optional and
	 * the whole object is optional: **absent means "use the rule"**, so
	 * nothing migrates and an older app ignores it entirely.
	 */
	titler: z
		.object({
			providerId: z.string().optional(),
			model: z.string().optional(),
		})
		.optional(),
});

export type Settings = z.infer<typeof Settings>;

export const settingsDefaults = (): Settings => Settings.parse({});

/**
 * Reason `setSettings` fails with while a stored blob is unreadable. A schema
 * regression must never silently replace that blob with defaults — the user
 * resets explicitly (`resetRejectedSettings`) or nothing is written at all.
 */
export const REJECTED_SETTINGS_MESSAGE =
	"stored settings are unreadable; refusing to overwrite";

/**
 * Canonical persisted chat message shape (was `state/chat.ts`).
 */
export const chatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "error"]),
	/**
	 * The model's own words — memory blocks stripped, and no
	 * display marker ever concatenated in. This is exactly the
	 * text that may go back on the wire: a later task replays
	 * stored messages to the model safely.
	 */
	text: z.string(),
	/**
	 * Display-only marker lines (tool calls, fetch and search
	 * outcomes), each recorded at the `text` offset it belongs
	 * to. Interleaved with `text` for the transcript only —
	 * never sent to the model. Defaulted so a stored
	 * conversation without them still parses.
	 */
	markers: z
		.array(
			z.object({
				at: z.number(),
				line: z.string(),
			}),
		)
		.default([]),
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
	/**
	 * Raw stored text when the last read failed to parse, so the UI can offer
	 * it for download; `none` while the store is readable.
	 */
	rejectedSettings(): Effect.Effect<Option.Option<string>>;
	/**
	 * The user's explicit "start fresh": clear the rejection so writes resume.
	 * The stored blob is not touched — the next `setSettings` overwrites it.
	 */
	resetRejectedSettings(): Effect.Effect<void>;
	/**
	 * Fails with {@link REJECTED_SETTINGS_MESSAGE} while a rejection stands, so
	 * a parse failure can never silently replace the stored blob with defaults.
	 */
	setSettings(patch: Partial<Settings>): Effect.Effect<void, string>;
}
