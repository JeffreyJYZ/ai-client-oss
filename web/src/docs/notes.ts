import type { DocCapability, DocEvent, DocSlot } from "@/docs/types";

/**
 * The curated half of the reference: one sentence per slot, per capability and
 * per event, keyed by the id the source declares. The ids themselves are never
 * retyped here — `build.ts` reads them from `ids.ts` and looks each one up, so
 * a new slot or capability appears with a neutral fallback rather than
 * disappearing. Only the prose lives in this file.
 */

export const slotNotes: Record<string, string> = {
	"ui.root.layout":
		"The root layout. The default shell is itself the default contribution, so replacing it takes over the whole app.",
	"app.sidebar": "The conversation sidebar.",
	"app.sidebar.actions": "Actions in the sidebar's header row.",
	"app.header": "The top bar.",
	"app.header.title": "The top bar's title region.",
	"app.header.actions": "The top bar's action buttons.",
	"app.notices":
		"Transient notices, such as the install advice and the update prompt.",
	"app.banner": "A persistent banner above the content.",
	"chat.pane": "The conversation pane.",
	"chat.messages": "The transcript's message list.",
	"chat.message": "One message's wrapper.",
	"chat.message.actions":
		"Per-message actions — copy, and anything a plugin adds.",
	"chat.empty": "The empty-conversation state.",
	"chat.stream-status": "The status row shown while a reply streams.",
	"composer.root": "The message composer.",
	"composer.toolbar": "The composer's toolbar row.",
	"composer.actions": "The composer's action buttons (send, attach, …).",
	"settings.root": "The Settings page.",
	"settings.nav": "Settings' section navigation.",
	"settings.sections":
		"The Settings sections themselves; every built-in section and every plugin section is one contribution.",
	"overlay.root":
		"Where host-rendered overlays live: toasts, modals and confirms.",
	"command.palette.results": "The command palette's result list.",
};

/** The fallback for a slot id with no note yet — neutral, never wrong. */
export const fallbackSlotNote =
	"A named UI region a contribution can render into.";

/**
 * The honest trust classification per capability (spec §7). `path-scoped` means
 * the API's shape keeps a plugin inside its own directory; `unenforceable`
 * means the label claims something the webview cannot gate; `consent-only`
 * means the label is displayed and consented to, and nothing more. None of
 * these is a sandbox — a plugin runs in-process with the app's privileges.
 */
const capabilityNotes: Record<string, Omit<DocCapability, "id">> = {
	"plugin-data": {
		unlocks:
			"A private data directory, reached through a handle bound to the plugin's own id.",
		enforced:
			"Path-scoped in Rust. Through the API a plugin cannot name another plugin's directory, but it can call the raw command with another id — so this is not a security boundary.",
		boundary: "path-scoped",
	},
	net: {
		unlocks: "Nothing in this build; the label is informational.",
		enforced:
			"Not enforceable. The webview has a global `fetch`, so a plugin can always reach the network whether or not it declares this.",
		boundary: "unenforceable",
	},
	window: {
		unlocks: "Window control. Not built in v1.",
		enforced:
			"Consent-only. The label is displayed and consented to; this build neither gates nor enforces it.",
		boundary: "consent-only",
	},
	shortcuts: {
		unlocks: "Global keyboard shortcuts. Not built in v1.",
		enforced:
			"Consent-only. The label is displayed and consented to; this build neither gates nor enforces it.",
		boundary: "consent-only",
	},
	invoke: {
		unlocks: "Calling Tauri commands beyond the plugin API. Not built in v1.",
		enforced:
			"Consent-only. The label is displayed and consented to; this build neither gates nor enforces it.",
		boundary: "consent-only",
	},
	"fs-any": {
		unlocks:
			"Filesystem access outside the plugin's own directories. Not built in v1.",
		enforced:
			"Consent-only. The label is displayed and consented to; this build neither gates nor enforces it.",
		boundary: "consent-only",
	},
};

/**
 * The note for a capability id, with a fallback that assumes *less* enforcement
 * than the label might suggest — the safe direction for a capability that was
 * added to the source without a note here.
 */
export const capabilityNote = (id: string): DocCapability => {
	const note = capabilityNotes[id];
	if (note === undefined) {
		return {
			id,
			unlocks: "Not documented yet.",
			enforced:
				"Consent-only until documented. This build makes no claim that it is enforced.",
			boundary: "consent-only",
		};
	}
	return { id, ...note };
};

const eventNotes: Record<string, string> = {
	"turn-start": "A model turn begins.",
	chunk: "A streamed chunk arrived.",
	"turn-end": "A model turn finished.",
	"conversation-changed": "A conversation was created, renamed or deleted.",
	"settings-changed": "Settings were written.",
	"tool-called": "The model called a tool.",
	"plugin-loaded": "A plugin finished loading.",
	"plugin-unloaded": "A plugin was unloaded.",
};

export const eventNote = (name: string): DocEvent => ({
	name,
	description: eventNotes[name] ?? "",
});

/** The slot rows, keyed off the ids `slotIds` declares. */
export const slotRow = (id: string): DocSlot => ({
	id,
	description: slotNotes[id] ?? fallbackSlotNote,
});
