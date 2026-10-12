import { GITHUB_REPOSITORY } from "@/constants/links";
import {
	authorGuidePath,
	pendingModules,
	referenceEntries,
} from "@/docs/entries";
import { capabilityNote, eventNote, slotRow } from "@/docs/notes";
import {
	extractModuleSymbols,
	extractStringConst,
	extractStringTuple,
	extractZodObjectFields,
} from "@/docs/surface";
import type { DocModule, DocReference } from "@/docs/types";

/**
 * Assemble the reference from source. IO is injected (`read`/`exists`) rather
 * than done here, so the generator, the coverage gate and any future caller all
 * build byte-identical data from the same function — the gate is meaningful
 * precisely because there is one builder, not one per caller.
 */

/** The slot map, capability labels and event names all live here. */
export const IDS_PATH = "src/lib/plugins/ids.ts";
/** The manifest page's fields come from this module's zod declaration. */
export const MANIFEST_PATH = "src/lib/plugins/manifest.ts";
/** The plugin API version is read from this module. */
export const HOST_PATH = "src/lib/plugins/host.ts";

export interface ReferenceInput {
	/** Read a path relative to `web/`; `null` when it does not exist. */
	readonly read: (path: string) => string | null;
	readonly exists: (path: string) => boolean;
	/** The build's own version (`web/package.json`). */
	readonly appVersion: string;
}

export const buildReference = ({
	read,
	exists,
	appVersion,
}: ReferenceInput): DocReference => {
	const modules: DocModule[] = referenceEntries(exists).map((entry) => {
		const source = read(entry.path);
		if (source === null) {
			return {
				path: entry.path,
				label: entry.label,
				summary: entry.summary,
				status: "pending",
				symbols: [],
			};
		}
		return {
			path: entry.path,
			label: entry.label,
			summary: entry.summary,
			status: "documented",
			symbols: extractModuleSymbols(entry.path, source, read),
		};
	});
	const ids = read(IDS_PATH) ?? "";
	const manifest = read(MANIFEST_PATH) ?? "";
	const host = read(HOST_PATH);
	return {
		apiVersion:
			host === null ? "" : (extractStringConst(host, "pluginApiVersion") ?? ""),
		appVersion,
		modules,
		slots: extractStringTuple(ids, "slotIds").map(slotRow),
		capabilities: extractStringTuple(ids, "capabilityIds").map(capabilityNote),
		manifestFields: extractZodObjectFields(manifest, "manifestSchema"),
		events: extractStringTuple(ids, "hostEventNames").map(eventNote),
		pending: pendingModules(exists).map((module) => module.path),
		authorGuide: {
			available: exists(authorGuidePath),
			url: `https://github.com/${GITHUB_REPOSITORY}/blob/main/${authorGuidePath}`,
		},
	};
};
