import { describe, expect, test } from "bun:test";
import { offerClause, offerHeadline, type UpdateOffer } from "@lib/updates";

/**
 * The offer's copy is the whole point of the split: only an updater offer may
 * claim an update *is available*. A GitHub-only offer is a release that
 * exists and a claim the user cannot act on.
 */

const githubOffer: UpdateOffer = { kind: "github", version: "9.9.9" };

describe("what the update surfaces may claim", () => {
	test("a GitHub-only offer is published, never available", () => {
		expect(offerHeadline(githubOffer)).not.toContain("is available");
		expect(offerHeadline(githubOffer)).toContain("9.9.9");
		expect(offerHeadline(githubOffer)).toContain("cannot install it in-app");
	});

	test("the clause carries the same distinction for a surface that renders the version itself", () => {
		expect(offerClause(githubOffer)).toBe(
			"is published, but this build cannot install it in-app.",
		);
		// The two compose, so a strip and a section can never disagree.
		expect(offerHeadline(githubOffer)).toBe(
			`Version 9.9.9 ${offerClause(githubOffer)}`,
		);
	});

	test("the updater kind is the one that says available", () => {
		// The updater handle cannot be built without the Tauri plugin, and the
		// copy only reads `version` — a structurally typed stand-in is enough to
		// pin the branch.
		const updaterOffer = {
			kind: "updater",
			version: "9.9.9",
			update: {},
		} as unknown as UpdateOffer;

		expect(offerClause(updaterOffer)).toBe("is available.");
		expect(offerHeadline(updaterOffer)).toBe("Version 9.9.9 is available.");
	});
});
