import { MANIFEST_FILE } from "@lib/plugins/loader";

/**
 * The `files` record a pasted install builds (spec §6): the manifest under its
 * own name, plus the one entry file under the name the field carries. `null`
 * when the fields cannot make an install — a blank manifest, a blank entry
 * name, or an entry name of `MANIFEST_FILE`, which would overwrite the manifest
 * and fail with nothing pointing at the name.
 *
 * Pure and free of any React import on purpose: the section's install button and
 * its click handler both read this one verdict, and a test can hold it without a
 * renderer.
 */
export const pastedFiles = (
	manifestText: string,
	entryName: string,
	entryText: string,
): Record<string, string> | null => {
	const name = entryName.trim();
	if (manifestText.trim() === "" || name === "" || name === MANIFEST_FILE) {
		return null;
	}
	return { [MANIFEST_FILE]: manifestText, [name]: entryText };
};
