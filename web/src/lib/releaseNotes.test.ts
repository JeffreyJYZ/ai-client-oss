import { describe, expect, test } from "bun:test";
import {
	extractReleaseBody,
	notesForVersion,
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

describe("the notes of one version", () => {
	const stacked = [
		"Download the installer for your platform from the assets below.",
		"",
		"**New in 0.6.3**",
		"",
		"- The nav rail.",
		"",
		"**New in 0.6.2**",
		"",
		"- Settings folds.",
		"",
		"**New in 0.6.1**",
		"",
		"- Plugin examples.",
		"",
		"**License:** GPL-3.0-only.",
	].join("\n");

	test("cuts the asked-for version out of a body that stacks several", () => {
		const notes = notesForVersion(stacked, "0.6.2");
		expect(notes).toContain("Settings folds");
		expect(notes).not.toContain("The nav rail");
		expect(notes).not.toContain("Plugin examples");
	});

	test("the newest section stops at the next version, and the oldest at the footer", () => {
		expect(notesForVersion(stacked, "0.6.3")).not.toContain("0.6.2");
		expect(notesForVersion(stacked, "0.6.1")).not.toContain("License");
	});

	test("a body with no version heading is returned whole", () => {
		expect(notesForVersion("Just some prose.", "0.6.3")).toBe(
			"Just some prose.",
		);
	});

	test("an unknown version falls back to the whole body rather than nothing", () => {
		expect(notesForVersion(stacked, "9.9.9")).toContain("The nav rail");
	});
});
