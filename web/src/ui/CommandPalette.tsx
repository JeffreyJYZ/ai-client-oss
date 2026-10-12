import {
	filterCommands,
	getCommandsSnapshot,
	installCommandBridge,
	runCommand,
	subscribeCommands,
} from "@lib/plugins/commands";
import { runtime } from "@lib/plugins/runtime";
import { useEffect, useState, useSyncExternalStore } from "react";
import { setPalette, useUIState } from "@/state/ui";
import Slot from "@/ui/slots/Slot";

/**
 * Close first, then run: a command that changes the view (new chat, settings)
 * should reveal its own result, not have the palette unmount on top of it.
 */
const runFromPalette = (id: string): void => {
	setPalette(false);
	runtime.runFork(runCommand(id));
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
					placeholder="Type a command…"
					aria-label="Command palette search"
					className="border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
				/>
				<div className="max-h-80 overflow-y-auto">
					<Slot id="command.palette.results" props={{ query }} />
				</div>
			</div>
		</div>
	);
}

/**
 * The built-in result list, registered at `command.palette.results`: every
 * command matching the query, in resolution order, with its keybinding. A
 * plugin can contribute its own list to the same slot instead.
 */
export function CommandResults(props: Record<string, unknown>) {
	const query = typeof props.query === "string" ? props.query : "";
	const commands = useSyncExternalStore(subscribeCommands, getCommandsSnapshot);
	const matches = filterCommands(commands, query);

	if (matches.length === 0) {
		return (
			<p className="px-3 py-4 text-sm text-neutral-500">
				No matching commands.
			</p>
		);
	}

	return (
		<ul className="flex flex-col">
			{matches.map((command) => (
				<li key={command.id}>
					<button
						type="button"
						onClick={() => runFromPalette(command.id)}
						className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
					>
						<span className="truncate">{command.title}</span>
						{command.keybinding === undefined ? null : (
							<kbd className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-neutral-500">
								{command.keybinding}
							</kbd>
						)}
					</button>
				</li>
			))}
		</ul>
	);
}
