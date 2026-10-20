/**
 * The settings sections the app knows about: the built-in folds (one home for
 * their contribution id, their heading and their DOM anchor) and the sections
 * plugins contribute. The sticky settings nav and the palette's settings
 * search read it; the live `settings.sections` slot decides which of them are
 * on screen and in what order.
 *
 * A section's id is also its contribution id in the `settings.sections` slot
 * (built-ins use `settings.section.*`, plugins use their own `section.id`), so
 * a nav entry can be joined with the live slot contributions to respect the
 * slot's order, hidden filter and area toggles. The anchor id is the DOM id of
 * the section's heading — it lives on an element that is always rendered (the
 * summary's heading) so it can be scrolled to even while the fold is closed.
 */

export interface SettingsSectionMeta {
	readonly id: string;
	readonly title: string;
	readonly anchorId: string;
	readonly keywords: readonly string[];
}

/** The built-in fold sections, by their contribution id. */
export const SETTINGS_SECTIONS = {
	providers: {
		id: "settings.section.providers",
		title: "Providers",
		anchorId: "settings-section-providers",
		keywords: ["provider", "model", "base url", "api key", "label"],
	},
	profiles: {
		id: "settings.section.profiles",
		title: "Profiles",
		anchorId: "settings-section-profiles",
		keywords: ["profile", "system prompt", "provider", "model"],
	},
	webSearch: {
		id: "settings.section.web-search",
		title: "Web search",
		anchorId: "settings-section-web-search",
		keywords: ["web search", "tinyfish", "page fetch", "max results"],
	},
	memory: {
		id: "settings.section.memory",
		title: "Memory",
		anchorId: "settings-section-memory",
		keywords: ["memory", "notes", "remember"],
	},
	backup: {
		id: "settings.section.backup",
		title: "Backup",
		anchorId: "settings-section-backup",
		keywords: ["backup", "export", "import"],
	},
	updates: {
		id: "settings.section.updates",
		title: "Updates",
		anchorId: "settings-section-updates",
		keywords: ["update", "version", "release"],
	},
	plugins: {
		id: "settings.section.plugins",
		title: "Plugins",
		anchorId: "settings-section-plugins",
		keywords: ["plugin", "example", "install", "built-in"],
	},
} as const;

/** Derive a stable DOM anchor id from a plugin-chosen section id. */
export const pluginSectionAnchorId = (sectionId: string): string =>
	`settings-plugin-section-${sectionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** Alias kept for callers that use the longer name. */
export const settingsPluginSectionAnchorId = pluginSectionAnchorId;

// --- dynamic registry for plugin-contributed sections ----------------------

export interface PluginSettingsSection {
	readonly id: string;
	readonly title: string;
	readonly anchorId: string;
	readonly keywords: readonly string[];
}

let pluginSections: readonly PluginSettingsSection[] = [];
let pendingFocus: string | null = null;
const listeners = new Set<() => void>();

let snapshot: {
	readonly pluginSections: readonly PluginSettingsSection[];
	readonly pendingFocus: string | null;
} = {
	pluginSections,
	pendingFocus,
};

const notify = (): void => {
	snapshot = { pluginSections, pendingFocus };
	for (const listener of listeners) listener();
};

export const getSettingsSectionsSnapshot = (): {
	readonly pluginSections: readonly PluginSettingsSection[];
	readonly pendingFocus: string | null;
} => snapshot;

export const subscribeSettingsSections = (
	listener: () => void,
): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** Register one plugin section. Re-registering the same id replaces the entry. */
export const registerPluginSettingsSection = (
	entry: PluginSettingsSection,
): (() => void) => {
	pluginSections = [...pluginSections.filter((e) => e.id !== entry.id), entry];
	notify();
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		pluginSections = pluginSections.filter((e) => e.id !== entry.id);
		notify();
	};
};

export const settingsSectionMeta = (
	id: string,
): {
	readonly title: string;
	readonly anchorId: string;
	readonly keywords: readonly string[];
} | null => {
	for (const meta of Object.values(SETTINGS_SECTIONS)) {
		if (meta.id === id) return meta;
	}
	const plugin = pluginSections.find((e) => e.id === id);
	if (plugin)
		return {
			title: plugin.title,
			anchorId: plugin.anchorId,
			keywords: plugin.keywords,
		};
	return null;
};

export const requestSettingsSectionFocus = (anchorId: string): void => {
	pendingFocus = anchorId;
	notify();
};

export const takeSettingsSectionFocus = (): string | null => {
	const value = pendingFocus;
	pendingFocus = null;
	notify();
	return value;
};

export const getPendingSettingsSectionFocus = (): string | null => pendingFocus;

/** True when a DOM id is one we registered (built-in or plugin). */
export const isSettingsSectionAnchor = (id: string): boolean =>
	Object.values(SETTINGS_SECTIONS).some((m) => m.anchorId === id) ||
	pluginSections.some((m) => m.anchorId === id);
