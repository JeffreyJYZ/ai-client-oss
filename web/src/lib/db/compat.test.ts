import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Backup } from "@lib/backup";
import backupJson from "@lib/db/__fixtures__/backup-pre-plugins.json";
import conversationJson from "@lib/db/__fixtures__/conversation-pre-plugins.json";
import settingsJson from "@lib/db/__fixtures__/settings-pre-plugins.json";
import { installConversationStore } from "@lib/db/__test-support__/fake-indexed-db";
import {
	clearInvokeCalls,
	fakeInvoke,
	installStorage,
	invokeCalls,
	setOutcome,
	setStoredConversations,
	setStoredSettings,
	storedSettings,
} from "@lib/db/__test-support__/fake-invoke";
import { DATA_VERSION, migrations } from "@lib/db/migrate";
import { readSettings } from "@lib/db/read";
import {
	type Conversation,
	conversationSchema,
	REJECTED_SETTINGS_MESSAGE,
	Settings,
} from "@lib/db/types";
import { web } from "@lib/db/web";
import { Effect, Option } from "effect";
import { z } from "zod";

/** The 0.2.3 settings shape: nine keys, before the additive plugin fields. */
type PrePluginsSettings = Omit<
	Settings,
	"dataVersion" | "pluginsEnabled" | "plugins"
>;

/**
 * A JSON module import widens string literals (`role: string`, `source:
 * string`), so a schema-typed `toEqual` rejects it. Re-annotate each fixture at
 * the schema type once, here, rather than casting at every assertion — the
 * schemas below still parse every fixture at runtime, so this asserts nothing
 * the tests do not otherwise check.
 */
const settingsFixture = settingsJson as PrePluginsSettings;
const conversationFixture = conversationJson as Conversation;
const backupFixture = backupJson as Backup;

/**
 * Spec §13's pre-release gate: frozen 0.2.3 fixtures must read unchanged under
 * the post-plugins schema, the current schema must round-trip plugin state, and
 * a blob nobody can parse must be preserved rather than wiped.
 *
 * The fixtures are hand-written to the *source* of the 0.2.3 shape
 * (`git show desktop-v0.2.3:web/src/lib/db/types.ts`): nine settings keys, a
 * string-enum `protocol`, and no `dataVersion` / `pluginsEnabled` / `plugins`.
 * They are realistic on purpose — a real key under a touched key and two
 * providers — so an accidental field drop cannot pass unnoticed.
 */

const run = <A>(effect: Effect.Effect<A, string>): Promise<A> =>
	Effect.runPromise(effect);

/**
 * `value` reduced to the shape `fixture` has: object keys taken from the
 * fixture, and arrays compared element-wise under the same rule. Anything the
 * fixture does not carry is dropped, anything it carries but `value` lost stays
 * as `undefined` so the `toEqual` fails. Needed because a *provider* gained a
 * key (`attribution`) after 0.2.3, and the fixture must stay a real 0.2.3 blob
 * rather than be edited to mention it.
 */
const projectOnto = (fixture: unknown, value: unknown): unknown => {
	if (Array.isArray(fixture)) {
		if (!Array.isArray(value)) return value;
		return value.map((entry, index) =>
			projectOnto(fixture[index] ?? fixture[0], entry),
		);
	}
	if (fixture !== null && typeof fixture === "object") {
		if (value === null || typeof value !== "object") return value;
		const source = value as Record<string, unknown>;
		const projected: Record<string, unknown> = {};
		for (const key of Object.keys(fixture)) {
			projected[key] = projectOnto(
				(fixture as Record<string, unknown>)[key],
				source[key],
			);
		}
		return projected;
	}
	return value;
};

/**
 * The frozen fixture's own keys taken from `settings`, so a later *additive*
 * `Settings` key cannot fail a test that is about *not losing* data — the key
 * set comes from the fixture, never from a hardcoded list of new keys.
 */
const prePluginsSubstance = (settings: Settings): Partial<Settings> => {
	const substance: Partial<Settings> = {};
	for (const key of Object.keys(settingsFixture)) {
		(substance as Record<string, unknown>)[key] = projectOnto(
			(settingsFixture as Record<string, unknown>)[key],
			(settings as Record<string, unknown>)[key],
		);
	}
	return substance;
};

/**
 * A protocol name only a plugin can register. The 0.2.3 build's `protocol` was
 * `z.enum(protocolNames)`, so it cannot name this — the downgrade hazard.
 */
const PLUGIN_PROTOCOL = "acme.custom-protocol";

/**
 * The 0.2.3 `Settings` shape, reduced to the field that a plugin protocol
 * breaks: `protocol` was `z.enum(["anthropic", "responses", "chatcompletions"])`
 * (`git show desktop-v0.2.3:web/src/lib/db/types.ts`). Defined inline because
 * the enum no longer exists in the tree.
 */
const legacySettingsShape = z.object({
	providers: z.array(
		z.object({
			protocol: z.enum(["anthropic", "responses", "chatcompletions"]),
		}),
	),
});

/** The real 0.2.3 blob after a round-trip, plus a plugin protocol + plugin state. */
const augmentedBlob = {
	...settingsFixture,
	providers: [
		{ ...settingsFixture.providers[0], protocol: PLUGIN_PROTOCOL },
		settingsFixture.providers[1],
	],
	dataVersion: DATA_VERSION,
	pluginsEnabled: true,
	plugins: [
		{
			id: "acme.theme",
			enabled: true,
			version: "1.2.0",
			capabilities: ["storage"],
			data: { theme: "solarized-dark", pinned: ["fetch_url"] },
		},
	],
};

/**
 * Filesystem check for the frozen fixtures. Every one has to exist as data;
 * the test below is where their content is asserted.
 */
describe("frozen pre-plugin fixtures exist", () => {
	test("the three fixture files carry the 0.2.3 shape", () => {
		expect(Object.keys(settingsFixture).sort()).toEqual(
			[
				"activeProviderId",
				"dismissedInstallNote",
				"dismissedUpdateVersion",
				"fetchToolEnabled",
				"memories",
				"memoriesEnabled",
				"profiles",
				"providers",
				"tinyfishApiKey",
			].sort(),
		);
		expect(backupFixture.version).toBe(1);
		expect(conversationFixture.messages.length).toBeGreaterThan(0);
	});
});

describe("the pre-plugin settings blob reads under the current schema", () => {
	test("a real apiKey and a memory's text survive end to end", async () => {
		const read = await run(readSettings(JSON.stringify(settingsFixture)));
		expect(read.kind).toBe("ok");
		if (read.kind !== "ok") return;

		const settings = read.settings;
		// Whole-value checks, not `success === true`: a value that parsed but
		// was dropped would pass a naive check. Each is compared to the fixture
		// it came from, with a non-empty guard so a blank fixture cannot pass.
		// Two providers, one with a key and one local.
		expect(settings.providers).toHaveLength(2);
		expect(settings.providers[0]?.apiKey).toBe(
			settingsFixture.providers[0].apiKey,
		);
		expect(settings.providers[0]?.apiKey).not.toBe("");
		expect(settings.providers[1]?.apiKey).toBe("");
		expect(settings.memories).toHaveLength(2);
		expect(settings.memories[1]?.text).toBe(settingsFixture.memories[1].text);
		expect(settings.memories[1]?.text).not.toBe("");
		expect(settings.profiles).toHaveLength(1);
		expect(settings.tinyfishApiKey).toBe(settingsFixture.tinyfishApiKey);
		expect(settings.tinyfishApiKey).not.toBe("");
		expect(settings.dismissedInstallNote).toBe(true);
		expect(settings.dismissedUpdateVersion).toBe(
			settingsFixture.dismissedUpdateVersion,
		);

		// Nothing the old blob carried was dropped: every key the frozen fixture
		// has survives with its value (keys added since are ignored on purpose).
		expect(prePluginsSubstance(settings)).toEqual(settingsFixture);
		expect(settings.dataVersion).toBe(DATA_VERSION);
	});

	test("the pre-plugin conversation fixture parses unchanged", () => {
		const parsed = conversationSchema.parse(conversationFixture);
		expect(parsed).toEqual(conversationFixture);
		expect(parsed.messages[1]?.reasoning).toBe(
			conversationFixture.messages[1].reasoning,
		);
		expect(parsed.messages[1]?.markers[1]?.line).toBe(
			conversationFixture.messages[1].markers[1].line,
		);
	});

	test("the shipped registry carries the memory migration, and substance is untouched", async () => {
		expect([...migrations].map((m) => m.to)).toEqual([DATA_VERSION]);

		const withoutField = await run(
			readSettings(JSON.stringify(settingsFixture)),
		);
		expect(withoutField.kind).toBe("ok");
		if (withoutField.kind !== "ok") return;

		// No `dataVersion` on disk: the shipped migration carries the blob to
		// the current version and seeds `memoryNotes` from `memories`, while
		// every key the frozen fixture carried is byte-for-byte intact.
		expect(withoutField.settings.dataVersion).toBe(DATA_VERSION);
		expect(withoutField.settings.memoryNotes).toHaveLength(
			settingsFixture.memories.length,
		);
		expect(prePluginsSubstance(withoutField.settings)).toEqual(settingsFixture);

		// An explicit `dataVersion: 0` has the same one migration pending, so it
		// too lands at the current version with substance intact.
		const atZero = await run(
			readSettings(JSON.stringify({ ...settingsFixture, dataVersion: 0 })),
		);
		expect(atZero.kind).toBe("ok");
		if (atZero.kind !== "ok") return;
		expect(atZero.settings.dataVersion).toBe(DATA_VERSION);
		expect(prePluginsSubstance(atZero.settings)).toEqual(settingsFixture);
	});
});

describe("the current schema round-trips the three additions", () => {
	test("a plugin protocol, plugins[] state and dataVersion all survive", async () => {
		const read = await run(readSettings(JSON.stringify(augmentedBlob)));
		expect(read.kind).toBe("ok");
		if (read.kind !== "ok") return;

		const settings = read.settings;
		expect(settings.dataVersion).toBe(DATA_VERSION);
		expect(settings.pluginsEnabled).toBe(true);
		expect(settings.providers[0]?.protocol).toBe(PLUGIN_PROTOCOL);
		expect(settings.plugins[0]?.data).toEqual({
			theme: "solarized-dark",
			pinned: ["fetch_url"],
		});
		// A second serialize/parse is lossless (what a settings write does).
		expect(Settings.parse(JSON.parse(JSON.stringify(settings)))).toEqual(
			settings,
		);
	});
});

describe("the downgrade hazard is fixed, not described", () => {
	test("a plugin protocol fails the frozen 0.2.3 protocol enum", () => {
		const parsed = JSON.parse(JSON.stringify(augmentedBlob));
		// The old build's enum cannot name a plugin protocol: a whole-object
		// failure — the class a 0.2.3 build defaulted past, which the safety
		// net asserted below is what stops the wipe.
		expect(legacySettingsShape.safeParse(parsed).success).toBe(false);
		// The current schema accepts the same blob — the widening is additive.
		expect(Settings.safeParse(parsed).success).toBe(true);
	});

	test("an unparseable stored blob is preserved and writes refuse", async () => {
		// A *different* blob from the plugin-protocol one above: the current
		// schema accepts that blob (the widening is the point), so the only way
		// to reach the safety net here is a whole-object failure the schema
		// cannot tolerate — the class a 0.2.3 downgrade produces.
		const unreadable = JSON.stringify({
			...settingsFixture,
			providers: [{ ...settingsFixture.providers[0], id: 1 }],
		});
		const store = installStorage(unreadable);

		await run(web.getSettings());

		expect(store.raw()).toBe(unreadable);
		expect(store.writes()).toBe(0);

		const result = await run(
			Effect.map(
				Effect.result(web.setSettings({ memoriesEnabled: false })),
				setOutcome,
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBe(REJECTED_SETTINGS_MESSAGE);
		expect(store.raw()).toBe(unreadable);
		expect(store.writes()).toBe(0);
	});
});

// The backup fixture: validated with `backupSchema` (the app's import shape),
// then driven through the desktop adapter directly. `@lib/db` picks its adapter
// once per process from `isDesktop`, so the composed `db` is not used here, and
// only the third-party Tauri `invoke` is mocked (shared with `safety.test.ts`).
mock.module("@tauri-apps/api/core", () => ({ invoke: fakeInvoke }));

const { tauri } = await import("@lib/db/tauri");
const { backupSchema } = await import("@lib/backup");

describe("the pre-plugin backup fixture", () => {
	beforeEach(async () => {
		setStoredSettings(null);
		clearInvokeCalls();
		await run(web.resetRejectedSettings());
		await run(tauri.resetRejectedSettings());
	});

	test("the BACKUP_VERSION-1 envelope validates with real values intact", () => {
		const parsed = backupSchema.safeParse(backupFixture);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;

		expect(parsed.data.settings.providers[0]?.apiKey).toBe(
			backupFixture.settings.providers[0].apiKey,
		);
		expect(parsed.data.settings.memories).toHaveLength(2);
		expect(parsed.data.conversations).toHaveLength(
			backupFixture.conversations.length,
		);
	});

	test("its parsed payload writes through the desktop adapter", async () => {
		const parsed = backupSchema.safeParse(backupFixture);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;

		await run(tauri.setSettings(parsed.data.settings));
		await run(tauri.upsertConversation(parsed.data.conversations[0]));

		expect(invokeCalls).toContain("db_set_settings");
		expect(invokeCalls).toContain("db_upsert_conversation");

		const written = JSON.parse(String(storedSettings()));
		expect(written.providers[0].apiKey).toBe(
			backupFixture.settings.providers[0].apiKey,
		);
		expect(written.memories).toHaveLength(2);
		expect(written.dataVersion).toBe(DATA_VERSION);
	});
});

/* ------------------------------------------------------- a title's source */

/**
 * `titleSource` records who wrote a conversation's title, and **absent means
 * `"derived"`** — the first user message's text. That is exactly what every
 * conversation stored before the field existed carries, and the frozen 0.2.3
 * fixture above is one of them, so nothing needs migrating.
 *
 * The field is *tolerated* (`z.enum([...]).optional().catch("derived")`), and
 * the second test is why: both adapters **discard** a conversation whose
 * `conversationSchema.safeParse` fails (`web.ts`'s `listConversations` and
 * `getConversation`, the desktop `tauri.ts`'s `parseConversation`), so a bare
 * optional enum would turn one unexpected value into a conversation the user
 * cannot see.
 */
describe("a conversation's titleSource", () => {
	test("a conversation stored without one reads as derived, and stays absent", () => {
		expect(conversationJson).not.toHaveProperty("titleSource");
		// The field is declared, and declared *tolerated*: a row without it is
		// a case the schema knows about, not an accident of the fixture.
		expect(Object.keys(conversationSchema.shape)).toContain("titleSource");
		const parsed = conversationSchema.parse(conversationFixture);

		// Absent — never `"model"` or `"user"`, the two values the titler
		// refuses to overwrite, so a legacy conversation stays titleable.
		expect(parsed.titleSource).toBeUndefined();
		expect(parsed.title).toBe(conversationFixture.title);
		// A round-trip adds nothing: the absence is not "migrated" into a value.
		expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty(
			"titleSource",
		);
	});

	test("a value outside the enum degrades instead of dropping the conversation", () => {
		const parsed = conversationSchema.safeParse({
			...conversationFixture,
			titleSource: "weird",
		});

		// `success` is the whole assertion: it is the predicate both adapters
		// keep a conversation by, so the row reads instead of vanishing.
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.titleSource).toBe("derived");
		// Degraded, not abbreviated: the rest of the conversation is intact.
		expect(parsed.data.title).toBe(conversationFixture.title);
		expect(parsed.data.messages).toEqual(conversationFixture.messages);
	});

	test("a value inside the enum is kept, not caught", () => {
		expect(
			conversationSchema.parse({
				...conversationFixture,
				titleSource: "user",
			}).titleSource,
		).toBe("user");
	});
});

/* --------------------------- the listing path, not just the predicate */

/**
 * The gap `safeParse` alone leaves open: `success` is the predicate, but the app
 * never calls it — the adapters run it inside their **listing path**
 * (`web.ts`'s `getAll` + `flatMap` and `getConversation`, the desktop
 * `tauri.ts`'s `db_list_conversations` + `parseConversation`), and a listing
 * that returned nothing would still pass a predicate-only test. So a raw row
 * carrying `{"titleSource": "weird"}` is put in the store and the adapter's own
 * `listConversations` is driven over it.
 *
 * A second, genuinely unparseable row rides along: it must still be **dropped**,
 * or a listing that ignored the schema entirely would satisfy the assertion.
 */
describe("a conversation with an unexpected titleSource survives the listing", () => {
	/** The degrade's subject, plus a row no schema can accept. */
	const weirdTitleSource = (): Record<string, unknown> => ({
		...conversationFixture,
		titleSource: "weird",
	});
	const unparseable = (): Record<string, unknown> => ({
		...conversationFixture,
		id: "conv-unparseable",
		messages: "not an array",
	});

	test("the desktop adapter lists it as derived, and still drops the unparseable row", async () => {
		setStoredConversations([weirdTitleSource(), unparseable()]);

		const listed = await run(tauri.listConversations());

		// Present, not vanished — the whole point of `catch("derived")`.
		expect(listed.map((c) => c.id)).toEqual([conversationFixture.id]);
		const survivor = listed[0];
		expect(survivor?.titleSource).toBe("derived");
		// Degraded, not abbreviated: the rest of the row is the fixture's.
		expect(survivor?.title).toBe(conversationFixture.title);
		expect(survivor?.messages).toEqual(conversationFixture.messages);
	});

	test("the web adapter lists it as derived, and still drops the unparseable row", async () => {
		const store = installConversationStore();
		try {
			store.seed([weirdTitleSource(), unparseable()]);

			const listed = await run(web.listConversations());

			expect(listed.map((c) => c.id)).toEqual([conversationFixture.id]);
			const survivor = listed[0];
			expect(survivor?.titleSource).toBe("derived");
			expect(survivor?.title).toBe(conversationFixture.title);
			expect(survivor?.messages).toEqual(conversationFixture.messages);

			// The second discard predicate in the same adapter: the single-row
			// read keeps the same conversation, and refuses the unparseable one.
			const fetched = await run(web.getConversation(conversationFixture.id));
			expect(Option.isSome(fetched) && fetched.value.titleSource).toBe(
				"derived",
			);
			const missing = await run(web.getConversation("conv-unparseable"));
			expect(Option.isNone(missing)).toBe(true);
		} finally {
			store.restore();
		}
	});
});
