import { describe, expect, test } from "bun:test";
import {
	extractReleaseBody,
	releaseNotesUrl,
	releaseTag,
	shouldShowReleaseNotes,
} from "@lib/releaseNotes";

describe("releaseNotes", () => {
	test("releaseTag builds the desktop release tag", () => {
		expect(releaseTag("0.6.2")).toBe("desktop-v0.6.2");
	});

	test("releaseNotesUrl points at the release by tag", () => {
		expect(releaseNotesUrl("0.6.2")).toBe(
			"https://api.github.com/repos/JeffreyJYZ/ai-client-oss/releases/tags/desktop-v0.6.2",
		);
	});

	test("extractReleaseBody reads the body out of a release payload", () => {
		expect(extractReleaseBody({ body: "## Notes\n\n- one" })).toBe(
			"## Notes\n\n- one",
		);
	});

	test("extractReleaseBody returns null when there are no notes", () => {
		expect(extractReleaseBody({})).toBeNull();
		expect(extractReleaseBody({ body: null })).toBeNull();
		expect(extractReleaseBody({ body: "" })).toBeNull();
		expect(extractReleaseBody({ body: "   " })).toBeNull();
		expect(extractReleaseBody(null)).toBeNull();
		expect(extractReleaseBody("not a payload")).toBeNull();
	});

	test("shouldShowReleaseNotes is true for a version never shown", () => {
		expect(shouldShowReleaseNotes("", "0.6.2")).toBe(true);
	});

	test("shouldShowReleaseNotes is false for the version already shown", () => {
		expect(shouldShowReleaseNotes("0.6.2", "0.6.2")).toBe(false);
	});

	test("shouldShowReleaseNotes is true for a newer version", () => {
		expect(shouldShowReleaseNotes("0.6.1", "0.6.2")).toBe(true);
	});

	test("shouldShowReleaseNotes is false without a running version", () => {
		expect(shouldShowReleaseNotes("", "")).toBe(false);
	});
});
