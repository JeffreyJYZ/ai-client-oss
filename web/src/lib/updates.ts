import { isDesktop } from "@lib/platform";
import {
	extractReleaseBody,
	RELEASE_TAG_PREFIX,
	releaseNotesUrl,
} from "@lib/releaseNotes";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	check,
	type DownloadEvent,
	type Update,
} from "@tauri-apps/plugin-updater";
import { Effect } from "effect";
import { GITHUB_REPOSITORY } from "@/constants/links";

/**
 * Version of the newest desktop release, read from the GitHub API.
 * Transport failures, rate limits, non-2xx responses and payloads
 * without a `tag_name` all land in the typed error channel, so
 * callers can treat the check as optional.
 *
 * A `403` here is the API's unauthenticated budget (60/hour per IP), not a
 * missing release — measured 2026-10-23, where the app reported
 * `release check failed (403)` while the release was live. The API is the
 * richer source, so it stays first; the CDN manifest is the fallback.
 */
const apiVersion = (): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		// `fetch` rejects only on transport failure; `tryPromise` maps
		// the rejection into the error channel.
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(
					`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`,
					{ headers: { accept: "application/vnd.github+json" }, signal },
				),
			catch: () => "release check failed",
		});
		if (!response.ok) {
			return yield* Effect.fail(`release check failed (${response.status})`);
		}
		// `response.json()` is asynchronous, and `Effect.try` in Effect 4
		// is synchronous-only, so the parse rides the same constructor.
		const payload = yield* Effect.tryPromise({
			try: () => response.json() as Promise<{ tag_name?: string }>,
			catch: () => "release payload unreadable",
		});
		const tag = payload.tag_name;
		if (typeof tag !== "string" || tag === "") {
			return yield* Effect.fail("release has no tag");
		}
		return tag.startsWith(RELEASE_TAG_PREFIX)
			? tag.slice(RELEASE_TAG_PREFIX.length)
			: tag;
	});

/**
 * The same version read from the release manifest — the file the in-app
 * updater already consumes, served by the CDN with no API call and no rate
 * limit. Its `version` is the release's own, so it is the natural fallback
 * when the API refuses the read.
 */
const manifestVersion = (): Effect.Effect<string, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(
					`https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/latest.json`,
					{ headers: { accept: "application/json" }, signal },
				),
			catch: () => "release check failed",
		});
		if (!response.ok) {
			return yield* Effect.fail(`release check failed (${response.status})`);
		}
		const payload = yield* Effect.tryPromise({
			try: () => response.json() as Promise<{ version?: string }>,
			catch: () => "release payload unreadable",
		});
		const version = payload.version;
		if (typeof version !== "string" || version.trim() === "") {
			return yield* Effect.fail("release manifest has no version");
		}
		return version.trim();
	});

/** The newest release's version: the API first, the CDN manifest if it refuses. */
export const latestVersion = (): Effect.Effect<string, string> =>
	apiVersion().pipe(Effect.catch(() => manifestVersion()));

/**
 * The release notes of one release: the body of the GitHub release whose tag
 * carries the version.
 *
 * The same endpoint the version check reads, one release by tag. Every failure
 * lands in the error channel — the transport refused the request, the API
 * answered with a non-2xx status (no such release, rate limited), the body
 * was not JSON — and a release that carries no body answers `null`, so the
 * caller shows nothing in every one of those cases.
 */
export const releaseNotesFor = (
	version: string,
): Effect.Effect<string | null, string> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(releaseNotesUrl(version), {
					headers: { accept: "application/vnd.github+json" },
					signal,
				}),
			catch: () => "release notes request failed",
		});
		if (!response.ok) {
			return yield* Effect.fail(
				`release notes request failed (${response.status})`,
			);
		}
		const payload = yield* Effect.tryPromise({
			try: () => response.json() as Promise<unknown>,
			catch: () => "release notes payload unreadable",
		});
		return extractReleaseBody(payload);
	});

/**
 * Dot-numbered comparison (`x.y.z`); total and pure — any side that
 * is not exactly `\d+.\d+.\d+` compares as not-newer.
 */
export const isNewer = (latest: string, current: string): boolean => {
	const pattern = /^\d+\.\d+\.\d+$/;
	if (!pattern.test(latest) || !pattern.test(current)) return false;
	const [latestMajor, latestMinor, latestPatch] = latest.split(".").map(Number);
	const [currentMajor, currentMinor, currentPatch] = current
		.split(".")
		.map(Number);
	return (
		latestMajor > currentMajor ||
		(latestMajor === currentMajor &&
			(latestMinor > currentMinor ||
				(latestMinor === currentMinor && latestPatch > currentPatch)))
	);
};

/**
 * A newer release, tagged with what can actually be done about it: `updater`
 * carries the handle `installUpdate` needs, `github` is only a version to
 * link to (a build without the updater plugin registered).
 */
export type UpdateOffer =
	| {
			readonly kind: "updater";
			readonly version: string;
			readonly update: Update;
	  }
	| { readonly kind: "github"; readonly version: string };

/** Version of the running build, read from the desktop shell. */
export const runningVersion = (): Effect.Effect<string, string> =>
	Effect.tryPromise({
		try: () => getVersion(),
		catch: () => "version read failed",
	});

/**
 * Ask the Tauri updater. `null` folds together every "nothing to install
 * in-app" answer — no newer release, the plugin not registered, a transport
 * failure, a manifest missing this platform's key — so callers fall through
 * to the release link instead of surfacing an error nobody can act on.
 *
 * No explicit `target` is passed: the plugin resolves `{os}-{arch}-{installer}`
 * then `{os}-{arch}` itself, and a universal macOS release publishes
 * `darwin-aarch64-app`/`darwin-aarch64` (and the x86_64 pair), so both
 * slices already match.
 */
const checkUpdater = (): Effect.Effect<Update | null> =>
	Effect.catch(
		Effect.tryPromise({
			try: () => check(),
			catch: () => "update check failed",
		}),
		() => Effect.succeed(null),
	);

/**
 * Find the newest release this build can act on. The Tauri updater wins when
 * it is registered: it knows the platform key and verifies the signature
 * before handing over a download. Otherwise — or when it finds nothing — the
 * GitHub releases API still answers "is there a newer version".
 */
export const findUpdate = (): Effect.Effect<UpdateOffer | null, string> =>
	Effect.gen(function* () {
		if (!isDesktop) return null;
		const update = yield* checkUpdater();
		const viaUpdater: UpdateOffer | null =
			update === null
				? null
				: { kind: "updater", version: update.version, update };
		if (viaUpdater !== null) return viaUpdater;
		const running = yield* runningVersion();
		const newest = yield* latestVersion();
		const viaGitHub: UpdateOffer | null = isNewer(newest, running)
			? { kind: "github", version: newest }
			: null;
		return viaGitHub;
	});

/**
 * What the UI may claim about an offer.
 *
 * Only an **updater** offer is an update this app can install. A GitHub-only
 * offer is a release that exists, and calling it "available" is a claim the
 * user cannot act on — measured 2026-10-20: the releases API already named
 * 0.6.3 while `latest.json` carried only Linux keys (macOS still building), so
 * the app said an update was available and offered no update button.
 */
export const offerClause = (offer: UpdateOffer): string =>
	offer.kind === "updater"
		? "is available."
		: "is published, but this build cannot install it in-app.";

/** The whole sentence, for a surface that shows the version as plain text. */
export const offerHeadline = (offer: UpdateOffer): string =>
	`Version ${offer.version} ${offerClause(offer)}`;

/**
 * Download and install `update`, reporting download progress to
 * `onProgress` as a 0-100 percentage, or `null` while the total size is
 * still unknown.
 *
 * `relaunch` is the last step because macOS and Linux only run the new version
 * after it; on Windows the installer exits the app first, so this effect
 * settling means the relaunch itself failed. Every failure surfaces as a
 * message in the typed error channel.
 */
export const installUpdate = (
	update: Update,
	onProgress: (percent: number | null) => void,
): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		let expected = 0;
		let received = 0;
		yield* Effect.tryPromise({
			try: () =>
				update.downloadAndInstall((event: DownloadEvent) => {
					if (event.event === "Started") {
						expected = event.data.contentLength ?? 0;
						received = 0;
						onProgress(expected === 0 ? null : 0);
						return;
					}
					if (event.event !== "Progress") return;
					received += event.data.chunkLength;
					onProgress(
						expected === 0
							? null
							: Math.min(100, Math.round((received / expected) * 100)),
					);
				}),
			catch: () => "update failed",
		});
		yield* Effect.tryPromise({
			try: () => relaunch(),
			catch: () => "restart failed",
		});
	});

/**
 * Hand back the Rust-side resource an unused update holds. Best effort — a
 * failure to release says nothing the user can act on, so it is swallowed.
 */
export const discardUpdate = (update: Update): Effect.Effect<void> =>
	Effect.catch(
		Effect.tryPromise({
			try: () => update.close(),
			catch: () => "release failed",
		}),
		() => Effect.void,
	);
