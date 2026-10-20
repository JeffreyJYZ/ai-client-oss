import { getCommandsSnapshot, subscribeCommands } from "@lib/plugins/commands";
import { useMemo, useSyncExternalStore } from "react";
import {
	type SearchCandidate,
	type SearchGroup,
	searchCandidates,
} from "@/lib/search";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { SHIPPED_PLUGIN_EXAMPLES } from "@/lib/shippedExamples";
import { useChat } from "@/state/chat";
import { usePlugins } from "@/state/plugins";
import { useSettings } from "@/state/settings";
import { useContribution } from "@/ui/slots/useContribution";
import { useSettingsSectionsSnapshot } from "@/ui/useSettingsSections";

export const usePaletteResults = (query: string): readonly SearchGroup[] => {
	const commands = useSyncExternalStore(subscribeCommands, getCommandsSnapshot);
	const chat = useChat();
	const settings = useSettings();
	const plugins = usePlugins();
	const contributions = useContribution("settings.sections");
	const sectionSnap = useSettingsSectionsSnapshot();

	const items = useMemo<readonly SearchCandidate[]>(() => {
		const out: SearchCandidate[] = [];
		// commands
		for (const c of commands) {
			out.push({
				kind: "command",
				id: c.id,
				title: c.title,
				subtitle: c.keybinding,
				keywords: [c.id],
			});
		}
		// conversations (most recent first)
		for (const c of chat.conversations) {
			const title = c.title.trim();
			if (title !== "") out.push({ kind: "conversation", id: c.id, title });
		}
		// providers
		for (const p of settings.providers) {
			const title = p.label.trim() || p.model || p.baseUrl;
			out.push({
				kind: "provider",
				id: p.id,
				title,
				subtitle: p.model || p.baseUrl || undefined,
				keywords: [p.label, p.model, p.baseUrl].filter((s) => s.trim() !== ""),
			});
		}
		// profiles
		for (const p of settings.profiles) {
			out.push({
				kind: "profile",
				id: p.id,
				title: p.name.trim() || p.model || "Untitled profile",
				subtitle: p.model || undefined,
				keywords: p.model.trim() !== "" ? [p.model] : [],
			});
		}
		// settings sections (live contributions ∩ title catalogue)
		const byId = new Map<
			string,
			{ title: string; keywords: readonly string[] }
		>();
		for (const m of Object.values(SETTINGS_SECTIONS))
			byId.set(m.id, { title: m.title, keywords: m.keywords });
		for (const m of sectionSnap.pluginSections)
			byId.set(m.id, { title: m.title, keywords: m.keywords });
		for (const c of contributions) {
			const m = byId.get(c.id);
			if (m)
				out.push({
					kind: "setting",
					id: c.id,
					title: m.title,
					keywords: [c.id, ...m.keywords],
				});
		}
		// plugins installed
		const seen = new Set<string>();
		for (const p of plugins.plugins) {
			const name = p.manifest?.name;
			if (name) {
				const id = `plugin:${p.state.id}`;
				if (!seen.has(id)) {
					seen.add(id);
					out.push({
						kind: "plugin",
						id,
						title: name,
						subtitle: p.manifest?.description,
						keywords: [p.state.id, p.manifest?.description ?? ""],
					});
				}
			}
		}
		// shipped examples
		for (const e of SHIPPED_PLUGIN_EXAMPLES) {
			const id = `example:${e.id}`;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({
				kind: "plugin",
				id,
				title: e.name,
				subtitle: e.description,
				keywords: [e.id, e.name, e.description],
			});
		}
		return out;
	}, [commands, chat, settings, plugins, contributions, sectionSnap]);

	return useMemo(
		() => searchCandidates(items, query, { perGroupLimit: 5 }),
		[items, query],
	);
};

export const useSearchResults = usePaletteResults;
