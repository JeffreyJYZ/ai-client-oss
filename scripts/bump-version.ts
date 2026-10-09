/**
 * Bump the desktop app version in every file that carries it.
 *
 * Usage: bun scripts/bump-version.ts <patch|minor|major|X.Y.Z> [--root <dir>]
 *
 * The current version is read from web/src-tauri/tauri.conf.json (the version
 * home — Tauri reads it for the bundle). The new version is written by targeted
 * text replacement only, so each file keeps its exact formatting (the JSON files
 * use tabs).
 *
 * The last line of stdout is the bare new version, so callers can capture it
 * with `tail -n1`. Invalid arguments exit 1 with a message on stderr.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

interface CliArgs {
	spec: string;
	root: string;
}

function fail(message: string): never {
	console.error(`bump-version: ${message}`);
	process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
	let spec: string | undefined;
	let root: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		if (arg === "--root") {
			const value = argv[i + 1];
			if (value === undefined || value === "") {
				fail("--root requires a directory argument");
			}
			root = value;
			i += 1;
		} else if (arg.startsWith("--root=")) {
			root = arg.slice("--root=".length);
		} else if (spec === undefined) {
			spec = arg;
		} else {
			fail(`unexpected argument "${arg}"`);
		}
	}
	if (spec === undefined) {
		fail(
			"usage: bun scripts/bump-version.ts <patch|minor|major|X.Y.Z> [--root <dir>]",
		);
	}
	return { spec, root: root ?? resolve(import.meta.dir, "..") };
}

function readTauriVersion(content: string): string {
	const match = /^\t"version": "([^"]*)"/m.exec(content);
	if (!match || match[1] === undefined) {
		throw new Error('tauri.conf.json: top-level "version" key not found');
	}
	if (!VERSION_RE.test(match[1])) {
		throw new Error(
			`tauri.conf.json: current version "${match[1]}" is not X.Y.Z`,
		);
	}
	return match[1];
}

function bumpVersion(current: string, spec: string): string {
	if (VERSION_RE.test(spec)) {
		return spec;
	}
	const [major, minor, patch] = current.split(".").map(Number);
	switch (spec) {
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "major":
			return `${major + 1}.0.0`;
		default:
			throw new Error(
				`invalid bump "${spec}" - expected patch, minor, major, or X.Y.Z`,
			);
	}
}

/** Replace the top-level "version" value in a tab-indented JSON file. */
function replaceTopLevelJsonVersion(
	content: string,
	next: string,
	file: string,
): string {
	const re = /^(\t"version": ")([^"]*)(")(,?)$/m;
	if (!re.test(content)) {
		throw new Error(`${file}: top-level "version" key not found`);
	}
	return content.replace(
		re,
		(_whole, open, _current, close, comma) => `${open}${next}${close}${comma}`,
	);
}

/** Replace the first line-anchored `version = "..."` (the [package] one). */
function replaceCargoTomlVersion(content: string, next: string): string {
	const re = /^version = "[^"]*"$/m;
	if (!re.test(content)) {
		throw new Error("Cargo.toml: [package] version line not found");
	}
	return content.replace(re, `version = "${next}"`);
}

/** Replace the `version` line inside the `[[package]]` block named "app". */
function replaceLockAppVersion(content: string, next: string): string {
	const nameMatch = /^name = "app"$/m.exec(content);
	if (!nameMatch) {
		throw new Error('Cargo.lock: no [[package]] block with name = "app"');
	}
	const afterName = content.slice(nameMatch.index + nameMatch[0].length);
	const versionMatch = /^version = "[^"]*"$/m.exec(afterName);
	if (!versionMatch) {
		throw new Error('Cargo.lock: version line missing after name = "app"');
	}
	const start = nameMatch.index + nameMatch[0].length + versionMatch.index;
	return (
		content.slice(0, start) +
		`version = "${next}"` +
		content.slice(start + versionMatch[0].length)
	);
}

async function main(): Promise<void> {
	const { spec, root } = parseArgs(process.argv.slice(2));
	const paths = {
		tauriConf: join(root, "web/src-tauri/tauri.conf.json"),
		cargoToml: join(root, "web/src-tauri/Cargo.toml"),
		cargoLock: join(root, "web/src-tauri/Cargo.lock"),
		packageJson: join(root, "web/package.json"),
	};

	const tauriConf = await readFile(paths.tauriConf, "utf8");
	const cargoToml = await readFile(paths.cargoToml, "utf8");
	const cargoLock = await readFile(paths.cargoLock, "utf8");
	const packageJson = await readFile(paths.packageJson, "utf8");

	const current = readTauriVersion(tauriConf);
	const next = bumpVersion(current, spec);

	await writeFile(
		paths.tauriConf,
		replaceTopLevelJsonVersion(tauriConf, next, "tauri.conf.json"),
	);
	await writeFile(paths.cargoToml, replaceCargoTomlVersion(cargoToml, next));
	await writeFile(paths.cargoLock, replaceLockAppVersion(cargoLock, next));
	await writeFile(
		paths.packageJson,
		replaceTopLevelJsonVersion(packageJson, next, "package.json"),
	);

	console.log(`bump-version: ${current} -> ${next} (${spec})`);
	console.log(
		"updated: web/package.json, web/src-tauri/Cargo.toml, web/src-tauri/Cargo.lock, web/src-tauri/tauri.conf.json",
	);
	console.log(next);
}

main().catch((error: unknown) => {
	console.error(
		`bump-version: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
