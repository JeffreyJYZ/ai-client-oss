import { getRegistrySnapshot, subscribeRegistry } from "@lib/plugins/bridge";
import { capabilityNote } from "@lib/plugins/consent";
import { useSyncExternalStore } from "react";
import type { PluginRuntimeState } from "@/state/plugins";
import { reload, setPluginEnabled, uninstall } from "@/state/plugins";
import ConfirmButton from "@/ui/ConfirmButton";
import { BUTTON, Button } from "@/ui/kit";
import { ContributionBoundary } from "@/ui/slots/ContributionBoundary";

/**
 * One installed plugin (spec §9): its identity, what it declares, what state it
 * is in, and its own controls.
 *
 * The per-plugin **settings area is a contribution point**: a plugin registers
 * a component into `settings.plugin.controls` and this row renders the entries
 * its own manifest id owns, so a plugin's controls appear in its own row and
 * nowhere else. The row resolves that from the registry snapshot directly
 * rather than through `Slot`, because `Slot` renders every entry in a slot —
 * the owner filter is the whole point of the region.
 *
 * The declared capabilities are rendered from `capabilityNote`, the one place
 * in the tree that states what each label is actually enforced by (spec §7), so
 * this row can never drift from the reference page.
 */

/** Where a plugin contributes the controls for its own row (spec §4). */
const CONTROLS_SLOT = "settings.plugin.controls";

const HEADING = "text-xs uppercase tracking-widest text-neutral-500";

const STATUS_TONE: Record<PluginRuntimeState["status"], string> = {
	loaded: "text-emerald-400",
	disabled: "text-neutral-500",
	failed: "text-red-400",
};

/** The components this plugin contributed for its own row, in slot order. */
const useControls = (pluginId: string) =>
	useSyncExternalStore(subscribeRegistry, getRegistrySnapshot).filter(
		(entry) =>
			entry.slot === CONTROLS_SLOT &&
			entry.owner === pluginId &&
			entry.hidden !== true,
	);

export function PluginRow({
	plugin,
	master,
}: {
	readonly plugin: PluginRuntimeState;
	readonly master: boolean;
}) {
	const id = plugin.state.id;
	const controls = useControls(id);
	const name = plugin.manifest?.name ?? id;
	const version = plugin.manifest?.version ?? plugin.state.version;
	const author = plugin.manifest?.author ?? "";
	const capabilities =
		plugin.manifest?.capabilities ?? plugin.state.capabilities;

	return (
		<li className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex min-w-0 flex-1 flex-col items-start text-left">
					<span className="w-full truncate text-sm text-neutral-100">
						{name}
					</span>
					<span className="w-full truncate text-xs text-neutral-500">
						{version.trim() === "" ? "no version" : `v${version}`}
						{author.trim() === "" ? "" : ` · ${author}`}
						{" · "}
						<span className={STATUS_TONE[plugin.status]}>{plugin.status}</span>
						{plugin.pending ? " · working…" : ""}
					</span>
				</span>
				<label className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
					Enabled
					<input
						type="checkbox"
						checked={plugin.state.enabled}
						disabled={!master}
						onChange={(event) => setPluginEnabled(id, event.target.checked)}
						className="h-4 w-4 accent-neutral-300 disabled:opacity-40"
					/>
				</label>
				<Button
					onClick={() => reload(id)}
					disabled={!master || plugin.pending}
					title="Unload and load this plugin again"
				>
					Reload
				</Button>
				<ConfirmButton
					label="Uninstall"
					confirmLabel="Confirm?"
					onConfirm={() => uninstall(id)}
					className={BUTTON}
				/>
			</div>

			{plugin.manifest?.description.trim() ? (
				<p className="text-xs text-neutral-500">
					{plugin.manifest.description}
				</p>
			) : null}

			{plugin.error === undefined ? null : (
				<p className="whitespace-pre-wrap break-words text-xs text-red-400">
					{plugin.error}
				</p>
			)}

			{capabilities.length === 0 ? (
				<p className="text-xs text-neutral-500">Declares no capabilities.</p>
			) : (
				<div className="flex flex-col gap-1">
					<span className={HEADING}>Declared capabilities</span>
					<ul className="flex flex-col gap-1">
						{capabilities.map((capability) => {
							const note = capabilityNote(capability);
							return (
								<li key={capability} className="text-xs text-neutral-500">
									<span className="text-neutral-300">{capability}</span>
									{" — "}
									{note.unlocks} {note.enforced}
								</li>
							);
						})}
					</ul>
				</div>
			)}

			<details className="flex flex-col gap-2">
				{/* No onClick on the summary: a control in a heading row owns its own
				    click, and preventing the default would cancel it (see the kit's
				    `Section`). */}
				<summary className={`cursor-pointer select-none ${HEADING}`}>
					Settings
				</summary>
				<div className="flex flex-col gap-2 pt-2">
					{controls.length === 0 ? (
						<p className="text-xs text-neutral-500">
							This plugin contributes no settings of its own.
						</p>
					) : (
						controls.map((entry) => {
							const Control = entry.component;
							return (
								<ContributionBoundary key={entry.id} owner={entry.owner}>
									<Control />
								</ContributionBoundary>
							);
						})
					)}
				</div>
			</details>
		</li>
	);
}
