import { useMemo, useSyncExternalStore } from "react";
import {
	getSettingsSectionsSnapshot,
	SETTINGS_SECTIONS,
	subscribeSettingsSections,
} from "@/lib/settingsSections";
import { useContribution } from "@/ui/slots/useContribution";

export interface SettingsSectionEntry {
	readonly id: string;
	readonly title: string;
	readonly anchorId: string;
	readonly keywords: readonly string[];
}

const BUILTINS = Object.values(
	SETTINGS_SECTIONS,
) as readonly SettingsSectionEntry[];

export const useSettingsSectionsSnapshot = () =>
	useSyncExternalStore(subscribeSettingsSections, getSettingsSectionsSnapshot);

export const useSettingsSectionEntries =
	(): readonly SettingsSectionEntry[] => {
		const contributions = useContribution("settings.sections");
		const snap = useSettingsSectionsSnapshot();
		return useMemo(() => {
			const byId = new Map<string, SettingsSectionEntry>();
			for (const m of BUILTINS) byId.set(m.id, m);
			for (const m of snap.pluginSections) byId.set(m.id, m);
			return contributions.flatMap((c) => {
				const m = byId.get(c.id);
				return m ? [m] : [];
			});
		}, [contributions, snap]);
	};
