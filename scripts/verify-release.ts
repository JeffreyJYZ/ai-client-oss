#!/usr/bin/env bun
/**
 * Verify a published desktop release before trusting it.
 *
 *   bun scripts/verify-release.ts                # version from tauri.conf.json
 *   bun scripts/verify-release.ts 0.1.2
 *   bun scripts/verify-release.ts 0.1.2 --tries 3
 *
 * Why this exists: a release is three runners' worth of artefacts plus a
 * *signed* updater manifest, and GitHub will happily show one that no user can
 * actually install. A run that started before the signing secrets existed
 * uploads the archives with no `.sig` beside them; a run that raced its own tag
 * push can leave `latest.json` naming the previous version; a platform whose
 * runner failed quietly leaves no manifest entry at all, which the app reads as
 * "no update" forever. `gh release view` proves none of that — only that the
 * bytes the updater will fetch are present, carry a signature, and are the
 * version we think we shipped.
 *
 * The version defaults to `web/src-tauri/tauri.conf.json` (the single version
 * home) and the repository is read from the git remote, so nothing here has to
 * be kept in sync by hand.
 */
import { join } from "node:path";

/** Tag form for a desktop release, e.g. `desktop-v0.1.2`. */
const TAG_PREFIX = "desktop-v";

/** Manifest the app's updater endpoint points at. */
const MANIFEST = "latest.json";

/** Flags that consume the following argument. */
const VALUE_FLAGS = new Set(["--tries", "--dir"]);

/**
 * Artefacts a complete release carries, matched by suffix rather than by full
 * name: the file name embeds the product name and version, which change.
 */
const REQUIRED_SUFFIXES = [
	".dmg", // macOS installer for humans
	".app.tar.gz", // macOS archive the updater installs
	".AppImage", // Linux updater artefact
	".deb",
	".rpm",
	"-setup.exe", // Windows installer + updater artefact
	".msi",
] as const;

/** Artefacts the updater downloads, so each needs its `.sig` beside it. */
const SIGNED_SUFFIXES = [
	".app.tar.gz",
	".AppImage",
	".deb",
	".rpm",
	"-setup.exe",
	".msi",
] as const;

/**
 * Platform keys the plugin resolves — `{os}-{arch}`, with `macos` mapped to
 * `darwin` (see `tauri-plugin-updater`'s `updater_os`). A missing entry is a
 * platform that can never auto-update.
 */
const REQUIRED_PLATFORMS = [
	"darwin-aarch64",
	"darwin-x86_64",
	"linux-x86_64",
	"windows-x86_64",
] as const;

interface ReleaseAsset {
	readonly name: string;
	readonly size: number;
}

interface Release {
	readonly tag_name: string;
	readonly draft: boolean;
	readonly prerelease: boolean;
	readonly assets: readonly ReleaseAsset[];
}

interface ManifestEntry {
	readonly signature?: string;
	readonly url?: string;
}

interface Manifest {
	readonly version?: string;
	readonly platforms?: Record<string, ManifestEntry>;
}

/** `owner/name` from the git remote, so the repo is never hard-coded. */
const repoFromGit = (): string => {
	const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"])
		.stdout.toString()
		.trim();
	const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
	if (!match?.[1]) {
		throw new Error(`cannot read owner/name from remote: ${remote}`);
	}
	return match[1];
};

/** The version this checkout claims to be — the release we are verifying. */
const localVersion = async (root: string): Promise<string | undefined> => {
	const config = (await Bun.file(
		join(root, "web/src-tauri/tauri.conf.json"),
	).json()) as { version?: string };
	return config.version;
};

const statusOf = async (url: string): Promise<number> => {
	try {
		const response = await fetch(url, { method: "HEAD", redirect: "follow" });
		return response.status;
	} catch {
		return 0;
	}
};

const getJson = async <T>(url: string): Promise<T | undefined> => {
	try {
		const response = await fetch(url, {
			headers: { accept: "application/vnd.github+json" },
			redirect: "follow",
		});
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
};

/** Suffixes a release's asset names fail to cover, in declaration order. */
export const missingSuffixes = (names: readonly string[]): string[] =>
	REQUIRED_SUFFIXES.filter(
		(suffix) => !names.some((name) => name.endsWith(suffix)),
	);

/** Updater artefacts present without the `.sig` the updater verifies. */
export const unsignedSuffixes = (names: readonly string[]): string[] =>
	SIGNED_SUFFIXES.filter(
		(suffix) =>
			names.some((name) => name.endsWith(suffix)) &&
			!names.some((name) => name.endsWith(`${suffix}.sig`)),
	);

/** One verdict line, so CI logs and a shell read the same thing. */
export const verdict = (
	version: string,
	facts: {
		readonly tag: string;
		readonly assets: number;
		readonly latest: string;
		readonly manifest: string;
	},
): string =>
	[
		`tag=${facts.tag}`,
		`assets=${facts.assets}`,
		`latest=${facts.latest}`,
		`manifest=${facts.manifest}`,
		`version=${version}`,
	].join(" ");

/** Every problem with one release's assets, as human-readable lines. */
export const assetProblems = (release: Release): string[] => {
	const names = release.assets.map((asset) => asset.name);
	const problems = missingSuffixes(names).map(
		(suffix) => `no asset ends with ${suffix}`,
	);
	problems.push(
		...unsignedSuffixes(names).map(
			(suffix) => `${suffix} has no ${suffix}.sig — the updater will reject it`,
		),
	);
	if (release.draft) problems.push("release is a draft");
	if (release.prerelease)
		problems.push("release is a prerelease — /releases/latest will skip it");
	return problems;
};

/** Problems with a fetched manifest: version, coverage, and each artefact. */
const manifestProblems = async (
	manifest: Manifest,
	version: string,
): Promise<string[]> => {
	const problems: string[] = [];
	if (manifest.version !== version) {
		problems.push(
			`manifest version is ${manifest.version ?? "(none)"}, expected ${version}`,
		);
	}
	const platforms = manifest.platforms ?? {};
	// A missing core key is a platform that can never update.
	for (const key of REQUIRED_PLATFORMS) {
		if (!platforms[key]) {
			problems.push(
				`manifest has no ${key} entry — that platform never updates`,
			);
		}
	}
	// Every entry, including the `-installer` variants the plugin tries first:
	// a signed URL that 404s is a failed update for whoever resolves it.
	for (const [key, entry] of Object.entries(platforms)) {
		if (!entry.signature) problems.push(`${key} entry has no signature`);
		const url = entry.url ?? "";
		if (!url) {
			problems.push(`${key} entry has no url`);
			continue;
		}
		const status = await statusOf(url);
		if (status !== 200) problems.push(`${key} artefact url returned ${status}`);
	}
	return problems;
};

const usage = (): void => {
	console.error(
		"usage: bun scripts/verify-release.ts [version] [--tries N] [--dir <root>]",
	);
};

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const value = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const root = value("--dir") ?? join(import.meta.dir, "..");
	const tries = Number(value("--tries") ?? 40);
	// A flag's value must not be mistaken for the version, and `--tries` takes
	// the next argument, so walk the list rather than filtering it.
	let explicit: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (!arg.startsWith("--")) explicit = arg;
	}
	const version = explicit ?? (await localVersion(root));
	if (!version || Number.isNaN(tries)) {
		usage();
		return 2;
	}
	if (!explicit)
		console.log(`no version given; using tauri.conf.json (${version})`);

	const repo = repoFromGit();
	const tag = `${TAG_PREFIX}${version}`;
	const api = `https://api.github.com/repos/${repo}/releases`;
	console.log(`verifying ${repo} ${tag}`);

	for (let attempt = 1; attempt <= tries; attempt++) {
		const release = await getJson<Release>(`${api}/tags/${tag}`);
		const latest = await getJson<Release>(`${api}/latest`);
		// Deliberately the endpoint the app itself uses: fetching it also proves
		// the /releases/latest 302 chain the updater follows.
		const manifest = await getJson<Manifest>(
			`https://github.com/${repo}/releases/latest/download/${MANIFEST}`,
		);
		const problems = release
			? assetProblems(release)
			: [`no release ${tag} yet`];
		if (release && latest?.tag_name !== tag) {
			problems.push(`/releases/latest is ${latest?.tag_name ?? "(none)"}`);
		}
		if (manifest) {
			problems.push(...(await manifestProblems(manifest, version)));
		} else {
			problems.push(`/releases/latest has no ${MANIFEST}`);
		}

		console.log(
			`try=${attempt} ${verdict(version, {
				tag: release?.tag_name ?? "(none)",
				assets: release?.assets.length ?? 0,
				latest: latest?.tag_name ?? "(none)",
				manifest: manifest
					? Object.keys(manifest.platforms ?? {}).join(",") || "(empty)"
					: "(none)",
			})}`,
		);

		if (problems.length === 0) {
			console.log(`verified ${tag} — ${release?.assets.length} assets`);
			return 0;
		}
		for (const problem of problems) console.error(`  - ${problem}`);
		if (attempt < tries) await Bun.sleep(20_000);
	}

	console.error(`timeout: ${tag} not fully published after ${tries} tries`);
	return 1;
}

if (import.meta.main) process.exit(await main());
