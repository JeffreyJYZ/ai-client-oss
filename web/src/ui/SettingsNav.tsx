import { useEffect } from "react";

import { takeSettingsSectionFocus } from "@/lib/settingsSections";
import {
	useSettingsSectionEntries,
	useSettingsSectionsSnapshot,
} from "@/ui/useSettingsSections";

export const activateSettingsSection = (id: string): void => {
	const target = document.getElementById(id);
	if (!target) return;
	const fold = target.closest("details");
	if (fold instanceof HTMLDetailsElement) fold.open = true;
	target.scrollIntoView({ behavior: "smooth", block: "center" });
};

export function SettingsNav() {
	const entries = useSettingsSectionEntries();
	const snap = useSettingsSectionsSnapshot();
	const pending = snap.pendingFocus;

	// Jump to a section requested from outside the settings surface (e.g. the
	// palette). The element exists once the sections have rendered, so retry on
	// every change of the live entry list.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (pending === null) return;
		const target = document.getElementById(pending);
		if (!target) return;
		const fold = target.closest("details");
		if (fold instanceof HTMLDetailsElement) fold.open = true;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		takeSettingsSectionFocus();
	}, [pending]);

	if (entries.length === 0) return null;

	return (
		<nav
			aria-label="Settings sections"
			className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-1 bg-neutral-950/95 px-1 py-2 backdrop-blur"
		>
			{entries.map((entry) => (
				<button
					key={entry.id}
					type="button"
					onClick={() => {
						const target = document.getElementById(entry.anchorId);
						if (!target) return;
						const fold = target.closest("details");
						if (fold instanceof HTMLDetailsElement) fold.open = true;
						target.scrollIntoView({ behavior: "smooth", block: "center" });
					}}
					className="rounded px-2 py-1 text-xs uppercase tracking-widest text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
				>
					{entry.title}
				</button>
			))}
		</nav>
	);
}
