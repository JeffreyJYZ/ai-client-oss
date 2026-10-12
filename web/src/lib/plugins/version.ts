/**
 * Version checks for the loader (spec §10), deliberately plain string
 * comparisons rather than semver ranges: the plugin API is unstable by
 * declaration, so a "compatible range" would overpromise. The plugin API's
 * `major.minor` is compared numerically — a different major is a refusal, a
 * different minor a warning — and `engines.app`'s bound is a plain `>=`
 * against the running app version. A version neither side can parse is a
 * warning, never a refusal, because a slightly odd string is no reason to
 * lose the plugin.
 */

/** A version reduced to its three comparable numbers. */
export interface ParsedVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Parse a dotted numeric version (`1`, `1.2`, `1.2.3`; a trailing space is
 * ignored). Returns `null` when the string is not one — the caller must tell
 * "could not read this" apart from "read it, and it does not match".
 */
export const parseVersion = (value: string): ParsedVersion | null => {
	const match = VERSION_PATTERN.exec(value.trim());
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: match[2] === undefined ? 0 : Number(match[2]),
		patch: match[3] === undefined ? 0 : Number(match[3]),
	};
};

/** `-1`, `0` or `1`: `a` relative to `b`, comparing major, then minor, then patch. */
export const compareVersions = (a: ParsedVersion, b: ParsedVersion): number => {
	const keys = ["major", "minor", "patch"] as const;
	for (const key of keys) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	return 0;
};

/** `ok` loads, `warn` loads with a logged reason, `refuse` fails the load. */
export type VersionVerdict = "ok" | "warn" | "refuse";

/** The outcome of one comparison, with a sentence fit to log. */
export interface VersionJudgement {
	readonly verdict: VersionVerdict;
	readonly detail: string;
}

/**
 * Judge the manifest's `apiVersion` against the plugin API this build
 * implements (spec §10). Same major and minor loads quietly; a different minor
 * warns (within a major the API only gains); a different major is refused. An
 * unparsable version on either side warns — it can never refuse.
 */
export const judgeApiVersion = (
	hostApi: string,
	pluginApi: string,
): VersionJudgement => {
	const host = parseVersion(hostApi);
	const plugin = parseVersion(pluginApi);
	if (host === null || plugin === null) {
		return {
			verdict: "warn",
			detail: `plugin API version "${pluginApi}" could not be compared against this build's "${hostApi}"; loading anyway`,
		};
	}
	if (host.major !== plugin.major) {
		return {
			verdict: "refuse",
			detail: `plugin targets plugin API ${pluginApi}, but this build implements ${hostApi}; a different major is not compatible, so the plugin must be rebuilt against ${hostApi}`,
		};
	}
	if (host.minor !== plugin.minor) {
		return {
			verdict: "warn",
			detail: `plugin targets plugin API ${pluginApi} while this build implements ${hostApi}; the same major only gains, so it loads with a warning`,
		};
	}
	return {
		verdict: "ok",
		detail: `plugin API ${pluginApi} matches this build`,
	};
};

/**
 * Judge the manifest's `engines.app` requirement against the running app
 * version (spec §10). A blank requirement or `*` accepts anything; a bound
 * (with or without a leading `>=`) is satisfied when the app version is not
 * older than it, and refused when it is. Anything else — a range we
 * deliberately do not implement, or a value that will not parse — warns.
 */
export const judgeEngine = (
	requirement: string,
	appVersion: string,
): VersionJudgement => {
	const constraint = requirement.trim();
	if (constraint === "" || constraint === "*") {
		return {
			verdict: "ok",
			detail: `plugin declares no app version requirement`,
		};
	}
	const bound = constraint.startsWith(">=")
		? constraint.slice(2).trim()
		: constraint;
	const required = parseVersion(bound);
	const app = parseVersion(appVersion);
	if (required === null || app === null) {
		return {
			verdict: "warn",
			detail: `plugin engine requirement "${requirement}" could not be compared against app ${appVersion}; loading anyway`,
		};
	}
	if (compareVersions(app, required) < 0) {
		return {
			verdict: "refuse",
			detail: `plugin requires app ${bound} or newer, but this build is ${appVersion}`,
		};
	}
	return {
		verdict: "ok",
		detail: `plugin engine requirement "${requirement}" is satisfied by app ${appVersion}`,
	};
};
