import { beforeEach, describe, expect, test } from "bun:test";
import { installStorage } from "@lib/db/__test-support__/fake-invoke";
import { companionDb } from "@lib/db/companion";
import { settingsDefaults } from "@lib/db/types";
import { web } from "@lib/db/web";
import { Effect } from "effect";

const TOKEN_KEY = "ai-client.companion";
const SETTINGS_KEY = "ai-client.settings";

const installCompanionStorage = (
	token: string | null,
	initialSettings: string | null,
) => {
	const map = new Map<string, string>();
	if (token !== null) map.set(TOKEN_KEY, JSON.stringify({ token }));
	if (initialSettings !== null) map.set(SETTINGS_KEY, initialSettings);
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		},
	} as unknown as Storage;
	return map;
};

describe("companion db adapter — unpaired", () => {
	beforeEach(() => {
		installStorage(null);
	});

	test("getSettings reads from localStorage", async () => {
		const blob = JSON.stringify({
			...settingsDefaults(),
			dismissedInstallNote: true,
		});
		installStorage(blob);
		const db = companionDb(web);
		const settings = await Effect.runPromise(db.getSettings());
		expect(settings.dismissedInstallNote).toBe(true);
	});

	test("setSettings writes to localStorage", async () => {
		installStorage(JSON.stringify(settingsDefaults()));
		const db = companionDb(web);
		await Effect.runPromise(db.setSettings({ memoriesEnabled: false }));
		const raw = globalThis.localStorage.getItem(SETTINGS_KEY);
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(String(raw)) as { memoriesEnabled: boolean };
		expect(parsed.memoriesEnabled).toBe(false);
	});
});

describe("companion db adapter — paired", () => {
	test("getSettings fetches from the companion", async () => {
		const daemonBlob = JSON.stringify({
			...settingsDefaults(),
			dismissedInstallNote: true,
		});
		installCompanionStorage("tok-1", null);
		const db = companionDb(web);
		globalThis.fetch = ((url: string) => {
			expect(url).toBe("http://127.0.0.1:47821/v1/settings");
			return Promise.resolve(new Response(daemonBlob, { status: 200 }));
		}) as unknown as typeof fetch;
		const settings = await Effect.runPromise(db.getSettings());
		expect(settings.dismissedInstallNote).toBe(true);
	});

	test("setSettings PUTs to the companion and mirrors locally", async () => {
		const daemonBlob = JSON.stringify(settingsDefaults());
		installCompanionStorage("tok-1", null);
		const db = companionDb(web);
		let putBody = "";
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") {
				putBody = String(init.body ?? "");
				return Promise.resolve(new Response("{}", { status: 200 }));
			}
			return Promise.resolve(new Response(daemonBlob, { status: 200 }));
		}) as unknown as typeof fetch;
		await Effect.runPromise(db.setSettings({ memoriesEnabled: false }));
		expect(putBody).not.toBe("");
		expect(JSON.parse(putBody).memoriesEnabled).toBe(false);
		expect(globalThis.localStorage.getItem(SETTINGS_KEY)).toBe(putBody);
	});

	test("a missing daemon falls back to browser-local data", async () => {
		const localBlob = JSON.stringify({
			...settingsDefaults(),
			dismissedInstallNote: true,
		});
		installCompanionStorage("tok-1", localBlob);
		const db = companionDb(web);
		globalThis.fetch = (() =>
			Promise.reject(new Error("refused"))) as unknown as typeof fetch;
		const settings = await Effect.runPromise(db.getSettings());
		expect(settings.dismissedInstallNote).toBe(true);
	});
});
