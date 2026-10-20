import { installCommandBridge, runCommand } from "@lib/plugins/commands";
import { runtime } from "@lib/plugins/runtime";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import type { SearchCandidate } from "@/lib/search";
import { requestSettingsSectionFocus } from "@/lib/settingsSections";
import { selectConversation } from "@/state/chat";
import { selectProvider } from "@/state/settings";
import { setPalette, setView, useUIState } from "@/state/ui";
import Slot from "@/ui/slots/Slot";
import { usePaletteResults } from "@/ui/usePaletteResults";

const activateResult = (item: SearchCandidate): void => {
	setPalette(false);
	switch (item.kind) {
		case "command":
			runtime.runFork(runCommand(item.id));
			break;
		case "conversation":
			selectConversation(item.id);
			setView("chat");
			break;
		case "provider": {
			selectProvider(item.id);
			setView("settings");
			requestSettingsSectionFocus("settings-section-providers");
			break;
		}
		case "profile":
			setView("settings");
			requestSettingsSectionFocus("settings-section-profiles");
			break;
		case "setting":
			setView("settings");
			requestSettingsSectionFocus(item.id);
			break;
		case "plugin":
			setView("settings");
			requestSettingsSectionFocus("settings-section-plugins");
			break;
	}
};

/**
 * The command palette overlay (spec §4/§5), registered at `overlay.root` by
 * `builtin/commands.ts`. It renders nothing while closed — a `<Slot>` adds no
 * element of its own and this component returns `null` — so the layout is
 * byte-identical until the palette is opened.
 *
 * It is only the shell: the search field and the `command.palette.results`
 * region. The result list is itself a contribution, so a plugin can replace how
 * commands are presented without replacing the palette.
 */
export function CommandPalette() {
	// Mounted once, before the first open, so the snapshot the result list reads
	// already exists when the palette appears.
	useEffect(() => {
		installCommandBridge();
	}, []);
	const { palette } = useUIState();
	if (!palette) return null;
	return <PalettePanel />;
}

/**
 * The open palette. Split from the shell above so the query resets on every
 * open: the component mounts on open and unmounts on close.
 */
function PalettePanel() {
	const [query, setQuery] = useState("");
	const groups = usePaletteResults(query);
	const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
	const [activeId, setActiveId] = useState<string | null>(null);

	useEffect(() => {
		setActiveId(flat[0]?.candidate.id ?? null);
	}, [flat[0]?.candidate.id]);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (flat.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			const i = flat.findIndex((h) => h.candidate.id === activeId);
			const next = (i + 1) % flat.length;
			setActiveId(flat[next].candidate.id);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			const i = flat.findIndex((h) => h.candidate.id === activeId);
			const prev = (i - 1 + flat.length) % flat.length;
			setActiveId(flat[prev].candidate.id);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const hit = flat.find((h) => h.candidate.id === activeId);
			if (hit) activateResult(hit.candidate);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24">
			<button
				type="button"
				aria-label="Close the command palette"
				onClick={() => setPalette(false)}
				className="absolute inset-0 cursor-default"
			/>
			<div className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl">
				<input
					// biome-ignore lint/a11y/noAutofocus: the palette is opened by a keystroke and exists to be typed into
					autoFocus
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search commands, chats, settings…"
					aria-label="Command palette search"
					className="border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
				/>
				<div className="max-h-80 overflow-y-auto">
					<Slot
						id="command.palette.results"
						props={{ query, groups, activeId, onSelect: activateResult }}
					/>
				</div>
			</div>
		</div>
	);
}

/**
 * The built-in result list, registered at `command.palette.results`: grouped
 * search results across every kind, ranked by match quality. A plugin can
 * contribute its own list to the same slot instead.
 */
export function CommandResults(props: Record<string, unknown>) {
	const groups = Array.isArray(props.groups)
		? (props.groups as readonly {
				kind: string;
				hits: readonly { candidate: SearchCandidate }[];
			}[])
		: [];
	const activeId = typeof props.activeId === "string" ? props.activeId : null;
	const onSelect =
		typeof props.onSelect === "function"
			? (props.onSelect as (c: SearchCandidate) => void)
			: null;

	if (groups.length === 0) {
		return (
			<p className="px-3 py-4 text-sm text-neutral-500">
				No matching commands.
			</p>
		);
	}

	return (
		<div className="flex flex-col">
			{groups.map((group) => (
				<div key={group.kind} className="flex flex-col">
					<div className="px-3 py-1 text-[10px] uppercase tracking-widest text-neutral-600">
						{group.kind}
					</div>
					<ul className="flex flex-col">
						{group.hits.map((hit) => {
							const active = hit.candidate.id === activeId;
							return (
								<li key={hit.candidate.id}>
									<button
										type="button"
										onClick={() => onSelect?.(hit.candidate)}
										className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-800 ${active ? "bg-neutral-800 text-neutral-100" : "text-neutral-200"}`}
									>
										<span className="flex min-w-0 flex-col">
											<span className="truncate">{hit.candidate.title}</span>
											{hit.candidate.subtitle ? (
												<span className="truncate text-xs text-neutral-500">
													{hit.candidate.subtitle}
												</span>
											) : null}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}
