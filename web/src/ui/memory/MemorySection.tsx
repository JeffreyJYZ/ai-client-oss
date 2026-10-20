import { MAX_MEMORY_NOTE_LENGTH } from "@lib/memory";
import {
	addMemory,
	MEMORY_DELETED_CAP,
	type MemoryResult,
	removeMemory,
	revertMemory,
	updateMemory,
} from "@lib/memoryNotes";
import { useState } from "react";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { setSettings, useSettings } from "@/state/settings";
import ConfirmButton from "@/ui/ConfirmButton";
import {
	BUTTON,
	Button,
	cls,
	INPUT,
	SECTION,
	SECTION_HEADING,
	SECTION_SUMMARY_WRAP,
	Section,
	SUBHEADING,
	SubSection,
} from "@/ui/kit";
import { memoryRows } from "@/ui/memory/memoryRows";

/**
 * The Memory settings section: the durable-memory list and its editor.
 *
 * Two switches govern memory, one level apart. The `app.memory` area
 * (`lib/plugins/builtin/memory.ts`) owns the whole feature: turning it off
 * removes this section, the five tools the same area contributes, the memory
 * prompt sent with each request while notes are live, the strip that removes
 * `<memory>` blocks from a reply, and the recording of notes the model writes.
 * The **Enabled** checkbox below turns memory off *within* the area — notes
 * stay visible here, but no prompt is sent and nothing is recorded.
 *
 * The area has to be the complete switch because that checkbox lives inside
 * the section the area owns: turning the area off hides the very control, so
 * anything the area left live — the injection, the store — would keep running
 * with no UI to see it or turn it off.
 *
 * Every write goes through T1's operations (`lib/memoryNotes.ts`), which are
 * the same ones the model's tools call, so a user edit and a model edit cannot
 * disagree about what memory is. Two exceptions, both deliberate:
 *
 * - **Remove is soft** (`removeMemory`), so a removed note stays restorable
 *   from the Recently deleted list — a user cannot destroy a live note here
 *   either, only the model's own rules are looser than the user's.
 * - **Purge is this component's alone.** The spec's asymmetry — the agent can
 *   soft-delete forever and never purge — is enforced by the *absence* of a
 *   purge operation, so there is none to import: this file drops the entry with
 *   a direct `setSettings({ memoryNotes: … })` write. Do not add one to the
 *   shared module to "tidy" this.
 */
export function MemorySection() {
	const settings = useSettings();
	const rows = memoryRows(settings.memoryNotes, Date.now());
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	const notes = settings.memoryNotes;

	/** Apply a T1 result: persist a success, show a refusal's own message. */
	const persist = (result: MemoryResult): boolean => {
		if (!result.ok) {
			setError(result.message);
			return false;
		}
		setError(null);
		setSettings({ memoryNotes: [...result.notes] });
		return true;
	};

	/**
	 * A user-typed note. The id is minted here and is unique by construction, so
	 * the add cannot collide; the model chooses its own ids and the migration
	 * slugs them, so the three writers never share a namespace by accident.
	 */
	const addNote = (): void => {
		const content = draft.trim();
		if (content === "") return;
		if (
			persist(
				addMemory(notes, `memory-${crypto.randomUUID()}`, content, Date.now()),
			)
		) {
			setDraft("");
		}
	};

	const removeNote = (id: string): void => {
		persist(removeMemory(notes, id, Date.now()));
	};

	const revertNote = (id: string): void => {
		persist(revertMemory(notes, id, Date.now()));
	};

	/** Irreversible: drop one soft-deleted note. The only purge path anywhere. */
	const purgeNote = (id: string): void => {
		setSettings({
			memoryNotes: notes.filter((note) => note.id !== id),
		});
	};

	const saveEdit = (): void => {
		if (editing === null) return;
		const content = editing.text.trim();
		// An empty draft is never saved. The Save control is disabled while the
		// draft is empty (that is the feedback); this guard keeps a submit path
		// that bypasses the button from blanking a note.
		if (content === "") return;
		// An unchanged save would push a no-op revision onto the history, so it
		// just closes the editor.
		const target = notes.find((note) => note.id === editing.id);
		if (target?.content === content) {
			setEditing(null);
			return;
		}
		if (persist(updateMemory(notes, editing.id, content, Date.now()))) {
			setEditing(null);
		}
	};

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY_WRAP}
			open={false}
			heading={
				<>
					<h3 id={SETTINGS_SECTIONS.memory.id} className={SECTION_HEADING}>
						{SETTINGS_SECTIONS.memory.title}
					</h3>
					<label className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
						Enabled
						<input
							type="checkbox"
							checked={settings.memoriesEnabled}
							onChange={(event) =>
								setSettings({ memoriesEnabled: event.target.checked })
							}
							className="h-4 w-4 accent-neutral-300"
						/>
					</label>
				</>
			}
		>
			<p className="text-xs text-neutral-500">
				One list of durable facts for every chat, sent with each request. The
				model can add, update and remove notes; you can edit, remove and undo
				them here.
			</p>

			{error === null ? null : <p className="text-xs text-red-400">{error}</p>}

			{rows.live.length === 0 ? (
				<p className="text-sm text-neutral-500">No memories yet.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{rows.live.map((row) => (
						<li
							key={row.id}
							className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
						>
							<div className="flex items-start gap-2">
								<span className="flex min-w-0 flex-1 flex-col items-start text-left">
									<span className="w-full break-words text-sm text-neutral-100">
										{row.content}
									</span>
									<span
										className="w-full truncate font-mono text-xs text-neutral-500"
										title={row.id}
									>
										{row.id} · changed {row.changed}
									</span>
								</span>
								<div className="flex shrink-0 items-center gap-2">
									{editing?.id === row.id ? null : (
										<Button
											onClick={() =>
												setEditing({ id: row.id, text: row.content })
											}
										>
											Edit
										</Button>
									)}
									<Button
										disabled={!row.canRevert}
										title={row.revertReason}
										onClick={() => revertNote(row.id)}
									>
										Undo
									</Button>
									<ConfirmButton
										label="Remove"
										confirmLabel="Confirm?"
										onConfirm={() => removeNote(row.id)}
										className={BUTTON}
									/>
								</div>
							</div>
							{!row.canRevert && row.revertReason !== undefined ? (
								<p className="text-xs text-neutral-500">{row.revertReason}</p>
							) : null}
							{editing?.id === row.id ? (
								<form
									className="flex gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										saveEdit();
									}}
								>
									<input
										// biome-ignore lint/a11y/noAutofocus: the editor opens in response to a click
										autoFocus
										type="text"
										value={editing.text}
										maxLength={MAX_MEMORY_NOTE_LENGTH}
										onChange={(event) =>
											setEditing({ id: row.id, text: event.target.value })
										}
										className={cls(INPUT, "flex-1")}
									/>
									<button
										type="submit"
										disabled={editing.text.trim() === ""}
										className={BUTTON}
									>
										Save
									</button>
									<button
										type="button"
										onClick={() => setEditing(null)}
										className={BUTTON}
									>
										Cancel
									</button>
								</form>
							) : null}
						</li>
					))}
				</ul>
			)}

			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					addNote();
				}}
			>
				<input
					type="text"
					value={draft}
					maxLength={MAX_MEMORY_NOTE_LENGTH}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Remember that…"
					className={INPUT}
				/>
				<button type="submit" disabled={draft.trim() === ""} className={BUTTON}>
					Add
				</button>
			</form>

			{rows.deleted.length === 0 ? null : (
				<SubSection heading={<p className={SUBHEADING}>Recently deleted</p>}>
					<p className="text-xs text-neutral-500">
						A removed note waits here, restorable, until you delete it forever.
						Only the {MEMORY_DELETED_CAP} most recently removed are kept:
						removing another drops the oldest from this list.
					</p>
					<ul className="flex flex-col gap-2">
						{rows.deleted.map((row) => (
							<li
								key={row.id}
								className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
							>
								<div className="flex items-center gap-2">
									<span className="flex min-w-0 flex-1 flex-col items-start text-left">
										<span className="w-full break-words text-sm text-neutral-400 line-through">
											{row.content}
										</span>
										<span
											className="w-full truncate font-mono text-xs text-neutral-600"
											title={row.id}
										>
											{row.id}
										</span>
									</span>
									<Button
										disabled={!row.canRevert}
										title={row.revertReason}
										onClick={() => revertNote(row.id)}
									>
										Restore
									</Button>
									<ConfirmButton
										label="Delete forever"
										confirmLabel="Confirm?"
										onConfirm={() => purgeNote(row.id)}
										className={BUTTON}
									/>
								</div>
								{!row.canRevert && row.revertReason !== undefined ? (
									<p className="text-xs text-neutral-500">{row.revertReason}</p>
								) : null}
							</li>
						))}
					</ul>
				</SubSection>
			)}
		</Section>
	);
}
