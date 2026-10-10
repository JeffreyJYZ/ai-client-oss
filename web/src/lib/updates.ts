import { isDesktop } from "@lib/platform";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import {
	check,
	type DownloadEvent,
	type Update,
} from "@tauri-apps/plugin-updater";
import { Effect } from "effect";
import { GITHUB_REPOSITORY } from "@/constants/links";

/** Release tags carry this prefix; the version is the tag minus it. */
const TAG_PREFIX = "desktop-v";

/**
 * Version of the newest desktop release, read from the GitHub API.
 * Transport failures, rate limits, non-2xx responses and payloads
 * without a `tag_name` all land in the typed error channel, so
 * callers can treat the check as optional.
 */
export const latestVersion = (): Effect.Effect<string, string> =>
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
		return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
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
const runningVersion = (): Effect.Effect<string, string> =>
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
