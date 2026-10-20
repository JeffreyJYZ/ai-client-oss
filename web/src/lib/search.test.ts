import { describe, expect, test } from "bun:test";
import {
	type SearchCandidate,
	type SearchGroup,
	searchCandidates,
} from "./search";

const findGroup = (groups: readonly SearchGroup[], kind: SearchGroup["kind"]) =>
	groups.find((g) => g.kind === kind);

describe("searchCandidates", () => {
	const items: readonly SearchCandidate[] = [
		{ kind: "command", id: "cmd-a", title: "New chat" },
		{ kind: "command", id: "cmd-b", title: "Toggle settings" },
		{ kind: "command", id: "cmd-c", title: "Export backup" },
		{ kind: "conversation", id: "c1", title: "Project plan" },
		{ kind: "conversation", id: "c2", title: "Backup review" },
		{ kind: "setting", id: "s1", title: "Backup", keywords: ["export"] },
		{
			kind: "plugin",
			id: "p1",
			title: "Hello world",
			keywords: ["adds a button"],
		},
	];

	test("empty query returns all groups in kind order", () => {
		const groups = searchCandidates(items, "");
		const kinds = groups.map((g) => g.kind);
		expect(kinds).toEqual(["command", "conversation", "setting", "plugin"]);
	});

	test("ranks exact title match first", () => {
		const groups = searchCandidates(items, "backup");
		const setting = findGroup(groups, "setting");
		expect(setting?.hits[0]?.candidate.title).toBe("Backup");
		const conv = findGroup(groups, "conversation");
		expect(conv?.hits[0]?.candidate.title).toBe("Backup review");
	});

	test("prefix beats substring", () => {
		const groups = searchCandidates(items, "New");
		const cmd = findGroup(groups, "command");
		expect(cmd?.hits[0]?.candidate.title).toBe("New chat");
	});

	test("no matches → group absent", () => {
		const groups = searchCandidates(items, "zzzzzz");
		expect(groups.length).toBe(0);
	});

	test("keyword match surfaces the entry via keywords", () => {
		const items2: readonly SearchCandidate[] = [
			{
				kind: "setting",
				id: "s1",
				title: "Web search",
				keywords: ["tinyfish", "page fetch"],
			},
		];
		const groups = searchCandidates(items2, "tinyfish");
		expect(groups.length).toBe(1);
		expect(groups[0]?.hits[0]?.candidate.title).toBe("Web search");
	});

	test("per-group cap trims", () => {
		const many: readonly SearchCandidate[] = Array.from(
			{ length: 10 },
			(_, i) => ({
				kind: "command" as const,
				id: `c${i}`,
				title: `Command ${i}`,
			}),
		);
		const groups = searchCandidates(many, "command", { perGroupLimit: 3 });
		const cmd = findGroup(groups, "command");
		expect(cmd?.hits.length).toBe(3);
	});

	test("non-matching kinds are omitted", () => {
		const groups = searchCandidates(items, "Toggle");
		const kinds = groups.map((g) => g.kind);
		expect(kinds).toEqual(["command"]);
	});
});
