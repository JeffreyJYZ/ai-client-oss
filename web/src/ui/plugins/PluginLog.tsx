import {
	clearLog,
	getLogSnapshot,
	type PluginLogLevel,
	subscribeLog,
} from "@lib/plugins/log";
import { useSyncExternalStore } from "react";
import { BUTTON, Section } from "@/ui/kit";

/**
 * The plugin log (spec §9): the lines `host.log` produced, plus the manager's
 * own load and unload notices, so a plugin that misbehaves has somewhere
 * visible to say so. The buffer is bounded (`PLUGIN_LOG_LIMIT`), so a
 * chatty plugin cannot grow it without limit.
 */

const HEADING = "text-xs uppercase tracking-widest text-neutral-500";

const LEVEL_TONE: Record<PluginLogLevel, string> = {
	debug: "text-neutral-600",
	info: "text-neutral-400",
	warn: "text-amber-300",
	error: "text-red-400",
};

export function PluginLog() {
	const entries = useSyncExternalStore(subscribeLog, getLogSnapshot);

	return (
		<Section
			className="flex flex-col gap-2 border-t border-neutral-800 pt-3"
			summaryClassName="flex cursor-pointer select-none items-center justify-between gap-3"
			open={false}
			heading={
				<>
					<h4 className={HEADING}>Plugin log</h4>
					<span className="text-xs text-neutral-500">
						{entries.length === 0
							? "empty"
							: `${entries.length} ${entries.length === 1 ? "line" : "lines"}`}
					</span>
				</>
			}
		>
			{entries.length === 0 ? (
				<p className="text-xs text-neutral-500">
					Nothing logged yet. A plugin&apos;s `host.log` lines, and every
					install, load, unload and failure this section performs, appear here.
				</p>
			) : (
				<ul className="max-h-48 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
					{entries.map((entry) => (
						<li
							key={entry.seq}
							className="whitespace-pre-wrap break-words font-mono text-xs"
						>
							<span className="text-neutral-600">
								{new Date(entry.at).toLocaleTimeString()}
							</span>{" "}
							<span className={LEVEL_TONE[entry.level]}>{entry.level}</span>
							{entry.pluginId === undefined ? null : (
								<>
									{" "}
									<span className="text-neutral-400">{entry.pluginId}</span>
								</>
							)}{" "}
							<span className="text-neutral-300">{entry.message}</span>
						</li>
					))}
				</ul>
			)}
			<div>
				<button
					type="button"
					onClick={clearLog}
					disabled={entries.length === 0}
					className={BUTTON}
				>
					Clear log
				</button>
			</div>
		</Section>
	);
}
