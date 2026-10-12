import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	clearInvokeCalls,
	fakeInvoke,
	installStorage,
	invokeCalls,
	type SetOutcome,
	setOutcome,
	setStoredSettings,
	storedSettings,
} from "@lib/db/__test-support__/fake-invoke";
import type { Db } from "@lib/db/types";
import {
	REJECTED_SETTINGS_MESSAGE,
	type Settings,
	settingsDefaults,
} from "@lib/db/types";
import { web } from "@lib/db/web";
import { Effect, Option } from "effect";

/** Valid JSON that does not satisfy `Settings` (a provider's `id` is not a string). */
const SCHEMA_INVALID = JSON.stringify({ providers: [{ id: 1 }] });
/** Not JSON at all. */
const UNPARSEABLE = '{"providers":';

mock.module("@tauri-apps/api/core", () => ({ invoke: fakeInvoke }));

const { tauri } = await import("@lib/db/tauri");

/**
 * Clear each adapter's rejection cell between tests. Guarded so a RED run
 * before the methods exist still reaches the preservation assertions (the
 * actual bug) instead of dying in setup.
 */
const clearRejections = async (): Promise<void> => {
	for (const adapter of [web, tauri] as Db[]) {
		const reset = (adapter as Partial<Db>).resetRejectedSettings;
		if (typeof reset === "function") {
			await Effect.runPromise(reset.call(adapter));
		}
	}
};

/** Seed the adapter's storage for one test; read back the raw value + write count. */
interface Access {
	readonly raw: () => string | null;
	readonly writes: () => number;
}

/** The contract both adapters must satisfy, parameterised by storage. */
interface Harness {
	readonly label: string;
	install(initial: string | null): Access;
	get(): Promise<Settings>;
	rejected(): Promise<Option.Option<string>>;
	reset(): Promise<void>;
	set(patch: Partial<Settings>): Promise<SetOutcome>;
}

const webHarness: Harness = {
	label: "web",
	install: (initial) => installStorage(initial),
	get: () => Effect.runPromise(web.getSettings()),
	rejected: () => Effect.runPromise(web.rejectedSettings()),
	reset: () => Effect.runPromise(web.resetRejectedSettings()),
	set: (patch) =>
		Effect.runPromise(
			Effect.map(Effect.result(web.setSettings(patch)), setOutcome),
		),
};

const tauriHarness: Harness = {
	label: "tauri",
	install(initial) {
		setStoredSettings(initial);
		clearInvokeCalls();
		return {
			raw: () => storedSettings(),
			writes: () => invokeCalls.filter((c) => c === "db_set_settings").length,
		};
	},
	get: () => Effect.runPromise(tauri.getSettings()),
	rejected: () => Effect.runPromise(tauri.rejectedSettings()),
	reset: () => Effect.runPromise(tauri.resetRejectedSettings()),
	set: (patch) =>
		Effect.runPromise(
			Effect.map(Effect.result(tauri.setSettings(patch)), setOutcome),
		),
};

for (const h of [webHarness, tauriHarness]) {
	describe(`${h.label} adapter — an unreadable settings blob is preserved`, () => {
		beforeEach(async () => {
			await clearRejections();
		});

		test("a schema-invalid blob reads as defaults and is left byte-identical", async () => {
			const store = h.install(SCHEMA_INVALID);

			expect(await h.get()).toEqual(settingsDefaults());

			expect(store.raw()).toBe(SCHEMA_INVALID);
			expect(store.writes()).toBe(0);
		});

		test("a non-JSON blob reads as defaults and is left byte-identical", async () => {
			const store = h.install(UNPARSEABLE);

			expect(await h.get()).toEqual(settingsDefaults());

			expect(store.raw()).toBe(UNPARSEABLE);
			expect(store.writes()).toBe(0);
		});

		test("rejectedSettings exposes the raw text of the blob that failed to parse", async () => {
			h.install(SCHEMA_INVALID);
			await h.get();

			expect(Option.getOrNull(await h.rejected())).toBe(SCHEMA_INVALID);
		});

		test("setSettings refuses while a rejection stands, leaving the blob byte-identical", async () => {
			const store = h.install(SCHEMA_INVALID);
			await h.get();

			const result = await h.set({ memoriesEnabled: false });

			expect(result.ok).toBe(false);
			expect(result.error).toBe(REJECTED_SETTINGS_MESSAGE);
			expect(store.raw()).toBe(SCHEMA_INVALID);
			expect(store.writes()).toBe(0);
		});

		test("resetRejectedSettings then setSettings writes fresh state and stays clear", async () => {
			const store = h.install(SCHEMA_INVALID);
			await h.get();

			await h.reset();
			expect(Option.isNone(await h.rejected())).toBe(true);

			const result = await h.set({ memoriesEnabled: false });

			expect(result.ok).toBe(true);
			expect(store.writes()).toBe(1);
			expect(JSON.parse(String(store.raw()))).toMatchObject({
				memoriesEnabled: false,
			});
			// The write made the store valid, so the rejection is not left set.
			expect(Option.isNone(await h.rejected())).toBe(true);
		});

		test("a valid blob records no rejection and behaves exactly as before", async () => {
			const validBlob = JSON.stringify({
				...settingsDefaults(),
				dismissedInstallNote: true,
			});
			const store = h.install(validBlob);

			const settings = await h.get();
			expect(settings.dismissedInstallNote).toBe(true);
			expect(Option.isNone(await h.rejected())).toBe(true);

			const result = await h.set({ memoriesEnabled: false });

			expect(result.ok).toBe(true);
			expect(store.writes()).toBe(1);
			expect(JSON.parse(String(store.raw()))).toMatchObject({
				dismissedInstallNote: true,
				memoriesEnabled: false,
			});
		});
	});
}
