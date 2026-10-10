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
