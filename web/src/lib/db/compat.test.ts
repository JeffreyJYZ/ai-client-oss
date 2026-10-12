import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Backup } from "@lib/backup";
import backupJson from "@lib/db/__fixtures__/backup-pre-plugins.json";
import conversationJson from "@lib/db/__fixtures__/conversation-pre-plugins.json";
import settingsJson from "@lib/db/__fixtures__/settings-pre-plugins.json";
import { DATA_VERSION, migrations } from "@lib/db/migrate";
import { readSettings } from "@lib/db/read";
import {
	type Conversation,
	conversationSchema,
	REJECTED_SETTINGS_MESSAGE,
	Settings,
} from "@lib/db/types";
import { SETTINGS_KEY, web } from "@lib/db/web";
import { Effect, Result } from "effect";
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

/** The five-hour-run outcome, flattened so the test never names an effect type. */
const setOutcome = (
	result: Result.Result<void, string>,
): { readonly ok: boolean; readonly error?: string } =>
	Result.isSuccess(result)
		? { ok: true }
		: { ok: false, error: result.failure };

/** A `localStorage` stand-in that records writes and exposes the raw value. */
const installStorage = (initial: string | null) => {
	const map = new Map<string, string>();
	if (initial !== null) map.set(SETTINGS_KEY, initial);
	let writes = 0;
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: (key: string): string | null => map.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			writes += 1;
			map.set(key, value);
		},
		removeItem: (key: string): void => {
			map.delete(key);
		},
		clear: (): void => map.clear(),
		key: (): string | null => null,
		get length(): number {
			return map.size;
		},
	} as unknown as Storage;
	return { raw: () => map.get(SETTINGS_KEY) ?? null, writes: () => writes };
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

		// Nothing the old blob carried was dropped: the parsed object minus the
		// three new keys is exactly the fixture.
		const { dataVersion, pluginsEnabled, plugins, ...substance } = settings;
		expect(substance).toEqual(settingsFixture);
		expect(dataVersion).toBe(DATA_VERSION);
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

	test("the migration registry ships empty and substance is untouched", async () => {
		expect([...migrations]).toEqual([]);

		const withoutField = await run(
			readSettings(JSON.stringify(settingsFixture)),
		);
		expect(withoutField.kind).toBe("ok");
		if (withoutField.kind !== "ok") return;

		// No `dataVersion` on disk: the zod default lifts the blob to the
		// current version, and the substance is byte-for-byte the fixture.
		expect(withoutField.settings.dataVersion).toBe(DATA_VERSION);
		const { dataVersion, pluginsEnabled, plugins, ...substance } =
			withoutField.settings;
		expect(substance).toEqual(settingsFixture);

		// An explicit `dataVersion: 0` with an empty registry has nothing to
		// migrate, so its version is left as stored — nothing changes (spec
		// §13: the machinery is the deliverable; the next schema change adds a
		// member with a real `to`).
		const atZero = await run(
			readSettings(JSON.stringify({ ...settingsFixture, dataVersion: 0 })),
		);
		expect(atZero.kind).toBe("ok");
		if (atZero.kind !== "ok") return;
		expect(atZero.settings.dataVersion).toBe(0);
		const {
			dataVersion: _zeroed,
			pluginsEnabled: _zeroPluginsEnabled,
			plugins: _zeroPlugins,
			...zeroSubstance
		} = atZero.settings;
		expect(zeroSubstance).toEqual(settingsFixture);
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
		// The old build's enum cannot name a plugin protocol: whole-object
		// failure, which in 0.2.3 was a default-and-wipe.
		expect(legacySettingsShape.safeParse(parsed).success).toBe(false);
		// The current schema accepts the same blob — the widening is additive.
		expect(Settings.safeParse(parsed).success).toBe(true);
	});

	test("an unparseable stored blob is preserved and writes refuse", async () => {
		// A whole-object parse failure — the class the 0.2.3 downgrade produces.
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

// The backup fixture imports through the app's real import path. `@lib/db`
// picks its adapter once per process (from `isDesktop`), and another test file
// imports it first, so inject the desktop adapter for this file: stub the Tauri
// `invoke` and mock `@lib/db` to hand `@lib/backup` that adapter. No filesystem
// is touched.
const invokeCalls: string[] = [];
let storedSettings: string | null = null;
const fakeInvoke = mock((command: string, args?: Record<string, unknown>) => {
	invokeCalls.push(command);
	if (command === "db_get_settings") return Promise.resolve(storedSettings);
	if (command === "db_set_settings") {
		storedSettings = String(args?.json ?? "");
		return Promise.resolve(null);
	}
	return Promise.resolve(null);
});
mock.module("@tauri-apps/api/core", () => ({ invoke: fakeInvoke }));

const { tauri } = await import("@lib/db/tauri");
mock.module("@lib/db", () => ({ db: tauri }));

const { importBackup } = await import("@lib/backup");

describe("the pre-plugin backup imports", () => {
	beforeEach(async () => {
		storedSettings = null;
		invokeCalls.length = 0;
		await run(web.resetRejectedSettings());
		await run(tauri.resetRejectedSettings());
	});

	test("the BACKUP_VERSION-1 envelope imports through importBackup", async () => {
		const result = await run(importBackup(backupFixture));
		expect(result).toEqual({
			conversations: backupFixture.conversations.length,
		});
		expect(invokeCalls).toContain("db_set_settings");
		expect(invokeCalls).toContain("db_upsert_conversation");

		const written = JSON.parse(String(storedSettings));
		expect(written.providers[0].apiKey).toBe(
			backupFixture.settings.providers[0].apiKey,
		);
		expect(written.memories).toHaveLength(2);
		expect(written.dataVersion).toBe(DATA_VERSION);

		// Reset the shared module-level `rejected` cell the adapter keeps.
		await run(web.resetRejectedSettings());
	});
});
