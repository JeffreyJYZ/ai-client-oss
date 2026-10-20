/**
 * Pure search helpers for the command palette. The palette's matching and
 * ranking live here so they are testable without a DOM; the palette itself is
 * a thin renderer that gathers candidates and calls `searchCandidates`.
 */

export type SearchKind =
	| "command"
	| "conversation"
	| "provider"
	| "profile"
	| "setting"
	| "plugin";

export const SEARCH_KIND_ORDER: readonly SearchKind[] = [
	"command",
	"conversation",
	"provider",
	"profile",
	"setting",
	"plugin",
];

export interface SearchCandidate {
	readonly kind: SearchKind;
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly keywords?: readonly string[];
}

export interface SearchHit {
	readonly candidate: SearchCandidate;
	readonly score: number;
}

export interface SearchGroup {
	readonly kind: SearchKind;
	readonly hits: readonly SearchHit[];
}

export interface SearchOptions {
	readonly perGroupLimit?: number;
}

const DEFAULT_LIMIT = 5;

function score(candidate: SearchCandidate, query: string): number {
	const q = query.toLowerCase();
	const title = candidate.title.toLowerCase();
	if (title === q) return 0;
	if (title.startsWith(q)) return 1;
	if (title.includes(q)) return 2;
	const kws = candidate.keywords?.map((k) => k.toLowerCase()) ?? [];
	if (kws.some((k) => k.includes(q))) return 3;
	const sub = candidate.subtitle?.toLowerCase() ?? "";
	if (sub.includes(q)) return 3;
	return 4;
}

export const searchCandidates = (
	items: readonly SearchCandidate[],
	query: string,
	options?: SearchOptions,
): readonly SearchGroup[] => {
	const q = query.trim().toLowerCase();
	const limit = options?.perGroupLimit ?? DEFAULT_LIMIT;
	const buckets = new Map<
		SearchKind,
		{ candidate: SearchCandidate; score: number; index: number }[]
	>();

	let index = 0;
	for (const candidate of items) {
		const s = q === "" ? 0 : score(candidate, q);
		if (q !== "" && s === 4) continue;
		let bucket = buckets.get(candidate.kind);
		if (!bucket) {
			bucket = [];
			buckets.set(candidate.kind, bucket);
		}
		bucket.push({ candidate, score: s, index });
		index += 1;
	}

	const groups: SearchGroup[] = [];
	for (const kind of SEARCH_KIND_ORDER) {
		const bucket = buckets.get(kind);
		if (!bucket || bucket.length === 0) continue;
		const sorted = bucket
			.map((entry) => entry)
			.sort((a, b) => a.score - b.score || a.index - b.index);
		const hits: SearchHit[] = sorted
			.slice(0, limit)
			.map(({ candidate, score: s }) => ({
				candidate,
				score: s,
			}));
		groups.push({ kind, hits });
	}
	return groups;
};
