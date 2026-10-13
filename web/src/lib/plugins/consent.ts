import { capabilityNote } from "@/docs/notes";

/**
 * The consent copy the Plugins section renders (spec §7/§9). Two halves,
 * deliberately from two different places:
 *
 * - **Per capability**, nothing is restated here. `capabilityNote` — the
 *   curated table the API reference is generated from — is re-exported, so
 *   `plugin-data` being path-scoped in Rust, `net` being unenforceable and the
 *   remaining labels being consent-only is stated once in the tree, and
 *   `src/docs/reference.test.ts` fails if that table ever loses the
 *   classification. A copy in this file would be the drift the brief forbids.
 * - **The subsystem-level statement**, below, has no other home: it is about
 *   what a plugin *is*, not about one label.
 *
 * What it must never do is imply a boundary the runtime does not have. A plugin
 * runs in-process with the app's own privileges; the master switch gates
 * *loading*, and nothing downstream of it limits an installed plugin.
 */
export { capabilityNote };

/**
 * The master-switch warning. It is the honest version of the trust model: full
 * trust, in process, with the app's own access — the switch is consent, not
 * containment.
 */
export const PLUGIN_TRUST_SUMMARY =
	"Plugins run inside this app with the app's own full access. Installing one means trusting it completely — nothing here limits what it can do.";

/**
 * The points the warning expands to, in the order the section renders them.
 * Every one is a claim the runtime makes true; none describes a boundary.
 */
export const PLUGIN_TRUST_POINTS: readonly string[] = [
	"A plugin can read every provider API key, the TinyFish key, every stored conversation, localStorage and IndexedDB, and the app's data directory.",
	"A plugin can make network requests, change the app's UI and settings, and call any desktop command this window is allowed to call.",
	"Capability labels are consent and display only: the scoped data directory is enforced by the desktop command's path handling, but a plugin can still call that command with another plugin's id, and every other label is a label alone.",
	"The switch below is the only gate. With it off, no plugin is loaded; with it on, every installed plugin that is enabled runs.",
];
