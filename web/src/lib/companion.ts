import { Effect } from "effect";

/**
 * The local companion: the desktop app's shell, exposed to a web page over
 * loopback so one file holds the settings and the credentials.
 *
 * This module is the page's half of that contract — the probe, the pairing,
 * the stored token and the status the Settings surface shows. The wire
 * contract is fixed (spec §"Wire contract"): `GET /v1/ping`, `POST /v1/pair`,
 * `GET`/`PUT /v1/settings` and `POST /v1/chat`, all on loopback, all with
 * `Authorization: Bearer <token>` except the first two.
 *
 * Two rules shape the code here:
 *
 * - **A failed probe is never an error the user sees.** The daemon may simply
 *   not be running, so `companionStatus` answers `absent` for a refused
 *   connection, a timeout and a non-`200` alike — it never fails.
 * - **Reading the stored token can throw** (a blocked storage partition, a
 *   page without storage), and a failure there means "not paired", not a crash.
 */

/** The port the companion listens on (fixed; the desktop side may override it). */
export const COMPANION_PORT = 47821;

/** The companion's origin: loopback only, never a routable host. */
export const COMPANION_ORIGIN = `http://127.0.0.1:${COMPANION_PORT}`;

/** `localStorage` key holding the pairing token, stored as `{"token":"…"}`. */
export const COMPANION_STORAGE_KEY = "ai-client.companion";

/** How long the status probe waits before calling the companion absent. */
export const COMPANION_PING_TIMEOUT_MS = 600;

/**
 * What the page knows about the companion: `absent` (nothing is listening),
 * `unpaired` (it is listening, but this page holds no token) or `paired` (it
 * is listening and this page holds a token).
 */
export type CompanionStatus = "absent" | "unpaired" | "paired";

/**
 * The `fetch` shape this module uses. A seam, not the global: a test injects
 * its own, so no test needs a live daemon and no port is ever bound.
 */
export type CompanionFetch = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

/** The injectable pieces of a companion call. */
export interface CompanionDeps {
	readonly fetch?: CompanionFetch;
}

/**
 * The sentence a refused request gets. The daemon relays the upstream status,
 * so a `401` is either the daemon's own token check or the provider's key —
 * the message names both, because only the first is fixable here.
 */
export const COMPANION_UNAUTHORIZED =
	"the local companion refused the request (401) — the stored pairing token is wrong, or the provider rejected the key";

/** The `fetch` a companion call uses: the injected one, else the page's. */
const fetcher = (deps?: CompanionDeps): CompanionFetch =>
	deps?.fetch ?? ((input, init) => globalThis.fetch(input, init));

/**
 * `String(cause)` that cannot itself throw. A rejection reason can be a value
 * whose own stringification throws, and describing it inside a catch function
 * would turn an isolated failure into a defect.
 */
const describeCause = (cause: unknown): Effect.Effect<string> =>
	Effect.sync(() => String(cause)).pipe(
		Effect.catchCause(() => Effect.succeed("an unprintable cause")),
	);

/**
 * Read one stored value. A storage that throws (or does not exist) reads as
 * "nothing stored" — a missing token is the unpaired state, not a fault.
 */
const readStored = (key: string): Effect.Effect<string | null> =>
	Effect.try({
		try: () => globalThis.localStorage.getItem(key),
		catch: () => "the companion token could not be read",
	}).pipe(Effect.orElseSucceed(() => null));

/** Write one stored value; a storage that refuses is a typed failure. */
const writeStored = (key: string, value: string): Effect.Effect<void, string> =>
	Effect.try({
		try: () => globalThis.localStorage.setItem(key, value),
		catch: () => "the companion token could not be stored",
	});

/** Remove one stored value; a storage that refuses is not an error. */
const removeStored = (key: string): Effect.Effect<void> =>
	Effect.try({
		try: () => globalThis.localStorage.removeItem(key),
		catch: () => "the companion token could not be removed",
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * The stored pairing token, or `null` when there is none. The value is read
 * from storage on every call, so a pairing takes effect without a reload.
 */
export const readStoredToken = (): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const raw = yield* readStored(COMPANION_STORAGE_KEY);
		if (raw === null) return null;
		const parsed = yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: () => "the stored companion token is not JSON",
		}).pipe(Effect.orElseSucceed(() => undefined));
		if (typeof parsed !== "object" || parsed === null) return null;
		const token = (parsed as { readonly token?: unknown }).token;
		return typeof token === "string" && token !== "" ? token : null;
	});

/**
 * Is the companion listening? A refused connection, a timeout and a non-`200`
 * all answer `false` — the page must never show a failure for a daemon that
 * simply is not running.
 */
export const companionRunning = (
	deps?: CompanionDeps,
): Effect.Effect<boolean> =>
	Effect.tryPromise({
		try: () =>
			fetcher(deps)(`${COMPANION_ORIGIN}/v1/ping`, {
				method: "GET",
				signal: AbortSignal.timeout(COMPANION_PING_TIMEOUT_MS),
			}),
		catch: () => "the local companion did not answer",
	}).pipe(
		Effect.map((response) => response.ok),
		Effect.orElseSucceed(() => false),
	);

/**
 * The companion's state, as the page sees it. Never fails: an unreachable
 * daemon is `absent`, not an error.
 */
export const companionStatus = (
	deps?: CompanionDeps,
): Effect.Effect<CompanionStatus> =>
	Effect.gen(function* () {
		const running = yield* companionRunning(deps);
		if (!running) return "absent" as const;
		const token = yield* readStoredToken();
		return token === null ? ("unpaired" as const) : ("paired" as const);
	});

/**
 * Pair this page with the companion. Only a `200` stores the token: a `401`
 * means the daemon's token differs from the one typed, and a rejected token
 * must never be remembered as if it had worked.
 */
export const pair = (
	token: string,
	deps?: CompanionDeps,
): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		const trimmed = token.trim();
		if (trimmed === "") {
			return yield* Effect.fail(
				"type the companion's token before pairing with it",
			);
		}
		const response = yield* Effect.tryPromise({
			try: () =>
				fetcher(deps)(`${COMPANION_ORIGIN}/v1/pair`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token: trimmed }),
				}),
			catch: (cause) => ({ cause }),
		}).pipe(
			Effect.catch((carrier) =>
				describeCause(carrier.cause).pipe(
					Effect.flatMap((detail) =>
						Effect.fail(`the local companion could not be reached: ${detail}`),
					),
				),
			),
		);
		if (response.status === 401) {
			return yield* Effect.fail(
				"the local companion rejected that token — check the token in the desktop app and try again",
			);
		}
		if (!response.ok) {
			return yield* Effect.fail(
				`the local companion answered ${response.status} to the pairing request`,
			);
		}
		yield* writeStored(
			COMPANION_STORAGE_KEY,
			JSON.stringify({ token: trimmed }),
		);
	});

/**
 * Forget the pairing. The page goes back to its own browser-local settings;
 * the daemon keeps whatever it already stored.
 */
export const unpair = (): Effect.Effect<void> =>
	removeStored(COMPANION_STORAGE_KEY);

/**
 * One authenticated request to the companion, for the routes the Settings
 * adapter owns (`GET`/`PUT /v1/settings`). A transport failure is a typed
 * `string`, never a defect.
 */
export const companionRequest = (
	token: string,
	path: string,
	init: RequestInit,
	deps?: CompanionDeps,
): Effect.Effect<Response, string> =>
	Effect.tryPromise({
		try: () =>
			fetcher(deps)(`${COMPANION_ORIGIN}${path}`, {
				...init,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					...init.headers,
				},
			}),
		catch: (cause) => ({ cause }),
	}).pipe(
		Effect.catch((carrier) =>
			describeCause(carrier.cause).pipe(
				Effect.flatMap((detail) => Effect.fail(detail)),
			),
		),
	);
