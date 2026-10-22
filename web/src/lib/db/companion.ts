import { companionRequest, readStoredToken } from "@lib/companion";
import { readSettings } from "@lib/db/read";
import {
	type Db,
	type Settings,
	Settings as SettingsSchema,
	settingsDefaults,
} from "@lib/db/types";
import { SETTINGS_KEY } from "@lib/db/web";
import { Effect, Result } from "effect";

/**
 * The settings adapter that makes the companion the source of truth for settings
 * when a token is stored: `getSettings`/`setSettings` go to `GET`/`PUT
 * /v1/settings`, while every other `Db` member stays on the wrapped adapter.
 *
 * Unpaired behaviour is byte-identical to the wrapped adapter: with no stored
 * token, both methods delegate unchanged. The `localStorage` mirror is still
 * written on a successful paired write, so an unpaired reload keeps its data.
 *
 * The two sources of truth are never both live: when the daemon is unreachable,
 * or the token is wrong, a paired page falls back to browser-local data rather
 * than silently merging.
 */
export const companionDb = (base: Db): Db => {
	const getSettings = (): Effect.Effect<Settings> =>
		Effect.gen(function* () {
			const token = yield* readStoredToken();
			if (token === null) return yield* base.getSettings();

			const response = yield* Effect.result(
				companionRequest(token, "/v1/settings", { method: "GET" }),
			);
			if (Result.isFailure(response)) return yield* base.getSettings();
			const res = response.success;
			if (res.status === 401) return yield* base.getSettings();
			if (res.status === 404) return yield* base.getSettings();
			if (!res.ok) return yield* base.getSettings();

			const raw = yield* Effect.tryPromise({
				try: () => res.text(),
				catch: () => "",
			});
			const read = yield* readSettings(raw);
			if (read.kind === "rejected") return settingsDefaults();
			return read.settings;
		}).pipe(Effect.catch(() => base.getSettings()));

	const setSettings = (patch: Partial<Settings>): Effect.Effect<void, string> =>
		Effect.gen(function* () {
			const token = yield* readStoredToken();
			if (token === null) return yield* base.setSettings(patch);

			const current = yield* getSettings();
			const parsed = SettingsSchema.safeParse({ ...current, ...patch });
			if (!parsed.success) return yield* Effect.fail("invalid settings");

			const body = JSON.stringify(parsed.data);
			const response = yield* Effect.result(
				companionRequest(token, "/v1/settings", {
					method: "PUT",
					body,
				}),
			);
			if (Result.isFailure(response) || !response.success.ok) {
				// The daemon is gone (or refused): stay on browser-local data.
				return yield* base.setSettings(patch);
			}

			// Mirror locally so an unpaired reload keeps its data.
			yield* Effect.try({
				try: () => globalThis.localStorage.setItem(SETTINGS_KEY, body),
				catch: () => "the companion mirror could not be written",
			}).pipe(Effect.orElseSucceed(() => undefined));
		});

	return {
		listConversations: () => base.listConversations(),
		getConversation: (id) => base.getConversation(id),
		upsertConversation: (c) => base.upsertConversation(c),
		deleteConversation: (id) => base.deleteConversation(id),
		getSettings,
		rejectedSettings: () => base.rejectedSettings(),
		resetRejectedSettings: () => base.resetRejectedSettings(),
		setSettings,
	};
};
