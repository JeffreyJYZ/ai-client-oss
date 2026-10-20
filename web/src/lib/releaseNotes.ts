import { z } from "zod";
import { GITHUB_REPOSITORY } from "@/constants/links";

/**
 * Release tags and the decision of whether to show them.
 *
 * Everything here is **pure**: the tag a version carries, where its notes
 * live, what a release payload says, and whether those notes are still unseen.
 * The read that fetches them lives in `lib/updates.ts`, next to the version
 * check that already talks to the same GitHub endpoint.
 *
 * The tag prefix is the one every desktop release carries (`desktop-v0.6.2`),
 * and it lives here because the release-note read and the update check must
 * agree on it — two spellings of the same tag would send the update check to
 * one release and the notes to another.
 */
export const RELEASE_TAG_PREFIX = "desktop-v";

/** The release tag for a version. */
export const releaseTag = (version: string): string =>
	`${RELEASE_TAG_PREFIX}${version}`;

/** The GitHub API endpoint for one release, by tag. */
export const releaseNotesUrl = (version: string): string =>
	`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${releaseTag(version)}`;

/**
 * The part of a release payload the notes come from. A release with no body
 * (or a body that is only whitespace) has no notes to show.
 */
const releasePayloadSchema = z.object({
	body: z.string().trim().min(1),
});

/**
 * The release notes out of a GitHub release payload, or `null` when the
 * payload carries none — a missing body, a null body, a payload that is not a
 * release at all.
 */
export const extractReleaseBody = (payload: unknown): string | null => {
	const parsed = releasePayloadSchema.safeParse(payload);
	return parsed.success ? parsed.data.body : null;
};

/**
 * Whether the running version's notes still need showing: the running version
 * differs from the one already dismissed. An empty running version (the shell
 * could not be asked) never shows anything.
 */
export const shouldShowReleaseNotes = (
	dismissedVersion: string,
	runningVersion: string,
): boolean => runningVersion !== "" && runningVersion !== dismissedVersion;
