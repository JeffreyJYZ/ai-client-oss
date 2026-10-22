import {
	BUILTIN_IDENTITIES,
	type BuiltinId,
} from "@lib/plugins/builtinIdentity";
import type { BuiltinsSnapshot } from "@/state/builtins";
import {
	applyBarePreset,
	restoreAllBuiltins,
	setBuiltinEnabled,
	setContributionEnabled,
	useBuiltins,
} from "@/state/builtins";
import { Button, Disclosure, SUBHEADING, SubSection } from "@/ui/kit";

/**
 * The Built-ins area of the Plugins section (spec "UI"): one row per built-in
 * area — its name, the one-line "what disappears when this is off", a toggle
 * and an expander — with the area's contributions as their own toggles inside,
 * plus the bare preset and restore-all.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * - **A contribution's key is the id its registry already holds** — a UI,
 *   command, provider or pipeline entry's own `id`, a tool's `declaration.name`,
 *   a theme's `id`, a settings section's `id`. `gateHost`
 *   (`lib/plugins/builtin/index.ts`) keys the registration filter on exactly
 *   that, so a derived key (a slot id plus something, a composite) produces a
 *   switch that writes an override the gate never reads: it does nothing, and
 *   every unit test stays green. {@link BUILTIN_CONTRIBUTIONS} is that id list,
 *   and `BuiltinsArea.test.ts` checks it against what the real registries
 *   actually register — the ids the gate reads — rather than trusting the list.
 * - **A locked unit is disabled with a stated reason, not merely refused in the
 *   log.** The store's `refused` guard remains the backstop (a locked area, and
 *   every contribution of it, is rejected there); this file is the visible half,
 *   so a control the user cannot use says why it is disabled. The manager's own
 *   section is the live example: it rides the locked `app.builtins`.
 *
 * The view-model is pure and lives here with the component because the two are
 * one feature: `builtinRows` is what the tests drive, and the component only
 * renders its output and wires the toggles to the store.
 */

/** The section's heading style, the Plugins section's own idiom. */
const HEADING = SUBHEADING;

/** The id list is the gate's key list — see the module comment. */
export const BUILTIN_CONTRIBUTIONS: Readonly<
	Record<BuiltinId, readonly string[]>
> = {
	// The container hosts a layout, and owns the settings surface every section
	// renders into — the surface is part of the way back, so it is locked with
	// the container (see `areas.ts` `registerSubstrate`).
	"app.substrate": ["settings.root.shell"],
	"app.shell": [
		"ui.root.layout",
		"shell.header.title",
		"shell.header.system-prompt",
		"shell.header.profile-picker",
		"shell.header.provider-picker",
		"shell.header.download",
		"shell.header.docs",
		"shell.header.settings-toggle",
		"shell.notices.install-note",
		"shell.notices.update",
	],
	"app.transcript": [
		"chat.pane",
		"chat.messages",
		"chat.empty",
		"chat.stream-status",
		"ui.message",
		"ui.markdown",
		"ui.marker",
		"ui.reasoning",
	],
	"app.composer": [
		"ui.composer",
		"ui.attachment-chip",
		"composer.toolbar.attach",
		"composer.toolbar.textarea",
		"composer.actions.stop",
		"composer.actions.send",
	],
	"app.overlay": ["overlay.toasts", "overlay.modal"],
	// A tool's key is its wire name, exactly as for `app.tools`; the five are
	// registered only while memory is on, so the gate and this catalog agree
	// about what the area contributes. The Memory **settings section** is the
	// area's sixth contribution — always registered with the area, and the one
	// control that turns the five on.
	"app.memory": [
		"memory_add",
		"memory_update",
		"memory_remove",
		"memory_revert",
		"memory_list",
		"settings.section.memory",
	],
	// The Titler **settings section** is the area's one contribution — always
	// registered with the area, and the only place its model choice can be made.
	// The titling run itself is not here: no registry holds it, so there is no
	// key for the gate to filter.
	"app.titler": ["settings.section.titler"],
	"app.settings": [
		"settings.section.notices",
		"settings.section.providers",
		"settings.section.provider-editor",
		"settings.section.profiles",
		"settings.section.profile-editor",
		"settings.section.web-search",
		"settings.section.variants",
		"settings.section.backup",
		"settings.section.updates",
		"app.sidebar.chats",
		"app.sidebar.actions.new-chat",
	],
	// A tool's key is its wire name.
	"app.tools": ["fetch_url", "web_search"],
	"app.providers": ["anthropic", "responses", "chatcompletions"],
	"app.commands": [
		"app.command.palette",
		"app.chat.new",
		"app.view.settings",
		"app.prompt.toggle",
		"app.chat.stop",
		"app.reply.copy",
		"app.updates.check",
		"app.backup.export",
		"command.palette",
		"command.palette.results",
	],
	"app.themes": ["app.theme.dark"],
	"app.builtins": ["settings.section.plugins"],
};

/**
 * Why each locked row is disabled — **one reason per locked row, and true of
 * that row**. The container and the manager are locked for different reasons,
 * and a single shared sentence ("…a surface to render into and a way back to
 * this list") made the App container's row claim the manager's job, which the
 * container does not have. A sentence on screen that is false of the thing it
 * is attached to is a defect, so each locked row names its own.
 */
const LOCKED_AREA_REASONS: Readonly<Partial<Record<BuiltinId, string>>> = {
	"app.substrate":
		"Locked: the app always needs a surface to render into, so the container cannot be turned off.",
	"app.builtins":
		"Locked: it is the way back to this list, so the manager cannot be turned off.",
};

/**
 * A locked row's sentence when {@link LOCKED_AREA_REASONS} has none for it —
 * general, and true of any locked unit. It keeps a locked row from ever
 * rendering as toggleable if a future identity joins the locked set without a
 * reason of its own (the store's refusal stays the backstop either way).
 */
const LOCKED_AREA_FALLBACK =
	"Locked: the irreducible core of the app cannot be turned off.";
const LOCKED_CONTRIBUTION_REASON =
	"Locked: it belongs to a locked area, which cannot be turned off.";

/** The honest line separating this section's two independent switches. */
const SWITCH_NOTE =
	'The "Enabled" switch at the top of this section gates installed third-party plugins, and is off by default. The built-ins below are part of the app itself: they ignore that switch, every area and contribution is on by default, and a disabled one stays off until it is turned back on here.';

/** One contribution's toggle row: the key the gate reads, and its state. */
export interface BuiltinContributionRow {
	/** The id the contribution's registry already holds (the gate's key). */
	readonly id: string;
	readonly enabled: boolean;
	/** Present when the unit cannot be toggled; the UI disables and states it. */
	readonly lockedReason?: string;
}

/** One area's row. */
export interface BuiltinRow {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly enabled: boolean;
	readonly lockedReason?: string;
	readonly contributions: readonly BuiltinContributionRow[];
}

/**
 * The pure view-model: the store's snapshot into rows. The enabled state is
 * read the way the reconciler reads it — an area is on only when its resolved
 * flag is `true`, a contribution is on unless it is recorded `false` — so the
 * UI and the gate cannot disagree about what is on.
 */
export const builtinRows = (
	snapshot: BuiltinsSnapshot,
): readonly BuiltinRow[] =>
	BUILTIN_IDENTITIES.map((identity) => {
		const locked = identity.locked === true;
		return {
			id: identity.id,
			label: identity.label,
			description: identity.description,
			enabled: snapshot.builtins[identity.id] === true,
			...(locked
				? {
						lockedReason:
							LOCKED_AREA_REASONS[identity.id] ?? LOCKED_AREA_FALLBACK,
					}
				: {}),
			contributions: BUILTIN_CONTRIBUTIONS[identity.id].map((id) => ({
				id,
				enabled: snapshot.contributions[identity.id]?.[id] !== false,
				...(locked ? { lockedReason: LOCKED_CONTRIBUTION_REASON } : {}),
			})),
		};
	});

/** One area: its identity line, its toggle, and its contribution expander. */
function AreaRow({ row }: { readonly row: BuiltinRow }) {
	return (
		<li className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
			<div className="flex flex-wrap items-start gap-2">
				<span className="flex min-w-0 flex-1 flex-col items-start text-left">
					<span className="text-sm text-neutral-100">{row.label}</span>
					<span className="text-xs text-neutral-500">{row.description}</span>
				</span>
				<label className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
					Enabled
					<input
						type="checkbox"
						checked={row.enabled}
						disabled={row.lockedReason !== undefined}
						title={row.lockedReason}
						onChange={(event) =>
							setBuiltinEnabled(row.id, event.target.checked)
						}
						className="h-4 w-4 accent-neutral-300 disabled:opacity-40"
					/>
				</label>
			</div>

			{row.lockedReason === undefined ? null : (
				<p className="text-xs text-amber-300/80">{row.lockedReason}</p>
			)}

			{/* No empty-state branch: every area in `BUILTIN_CONTRIBUTIONS` has at
			    least one id, and a mismatch between that catalog and what the
			    real registries hold fails `BuiltinsArea.test.ts`'s catalog
			    check. */}
			<details className="flex flex-col gap-2">
				{/* No onClick on the summary: nothing here needs one, and a
				    preventDefault would cancel a control's own activation. */}
				<summary className="flex cursor-pointer select-none items-center gap-2">
					<Disclosure />
					<span className={HEADING}>
						Contributions ({row.contributions.length})
					</span>
				</summary>
				<ul className="flex flex-col gap-1 pt-2">
					{row.contributions.map((contribution) => (
						<li
							key={contribution.id}
							className="flex flex-wrap items-center gap-2"
						>
							<span
								className="truncate font-mono text-xs text-neutral-400"
								title={contribution.id}
							>
								{contribution.id}
							</span>
							{contribution.lockedReason === undefined ? null : (
								<span className="text-xs text-amber-300/80">
									{contribution.lockedReason}
								</span>
							)}
							<label className="ml-auto flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
								<input
									type="checkbox"
									checked={contribution.enabled}
									disabled={contribution.lockedReason !== undefined}
									title={contribution.lockedReason}
									onChange={(event) =>
										setContributionEnabled(
											row.id,
											contribution.id,
											event.target.checked,
										)
									}
									className="h-4 w-4 accent-neutral-300 disabled:opacity-40"
								/>
							</label>
						</li>
					))}
				</ul>
			</details>
		</li>
	);
}

/** The Built-ins area: the bare preset, restore-all, and one row per area. */
export function BuiltinsArea() {
	const snapshot = useBuiltins();
	const rows = builtinRows(snapshot);

	return (
		<SubSection
			heading={
				<>
					<p className={HEADING}>Built-ins</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							onClick={applyBarePreset}
							title="Turn every built-in off except the locked core: a bare host with a way back"
						>
							Bare preset
						</Button>
						<Button
							onClick={restoreAllBuiltins}
							title="Turn every built-in area and contribution back on"
						>
							Restore all
						</Button>
					</div>
				</>
			}
		>
			<p className="text-xs text-neutral-500">{SWITCH_NOTE}</p>

			<ul className="flex flex-col gap-2">
				{rows.map((row) => (
					<AreaRow key={row.id} row={row} />
				))}
			</ul>
		</SubSection>
	);
}
