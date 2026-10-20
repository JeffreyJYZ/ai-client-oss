import { isDesktop } from "@lib/platform";
import { resolveTitlerModel } from "@lib/titler";
import { getTitlerOutcome, subscribeTitlerOutcome } from "@lib/titlerStatus";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { setSettings, useSettings } from "@/state/settings";
import { Button, INPUT, LABEL, SECTION_HEADING, Section } from "@/ui/kit";
import { filterTitlerOptions } from "@/ui/titler/titlerFilter";
import {
	AUTOMATIC_KEY,
	type TitlerModelChoice,
	titlerOptionKey,
	titlerRows,
	titlerSelectionPatch,
} from "@/ui/titler/titlerRows";

/**
 * The Titler settings section: which model names a new conversation, and what
 * the last attempt did.
 *
 * It is owned by the `app.titler` area (`lib/plugins/builtin/titler.ts`), so
 * switching the area off takes this row — and the model choice it explains —
 * with it. Like the Memory section it is registered unconditionally while the
 * area is on, because the picker is the only way to answer the rule's
 * "unresolved" state.
 *
 * The component is deliberately thin: `titlerRows` owns every word and every
 * option, so the three states and the picker's contents are provable without a
 * renderer (see `titlerRows.test.ts`). Here the store is read, the resolved
 * model comes from the same pure rule the area uses, and a choice is written
 * back through the app's own settings path.
 */

/** The last attempt, as the status record's own subscription exposes it. */
const useTitlerOutcome = () =>
	useSyncExternalStore(subscribeTitlerOutcome, getTitlerOutcome);

interface PickerEntry {
	readonly key: string;
	readonly label: string;
	readonly automatic: boolean;
	readonly saved: boolean;
	readonly model: string;
	readonly providerId: string;
}

export function TitlerSection() {
	const settings = useSettings();
	const status = useTitlerOutcome();
	const rows = titlerRows({
		// The same pure rule the area runs, so the hint cannot claim a model the
		// area would not use.
		resolved: resolveTitlerModel(settings, isDesktop),
		providers: settings.providers,
		selection: settings.titler,
		status,
	});

	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listId = useId();

	const entries: readonly PickerEntry[] = [
		{
			key: AUTOMATIC_KEY,
			label: "Automatic (free)",
			automatic: true,
			saved: false,
			model: "",
			providerId: "",
		},
		...rows.options.map((option) => ({
			key: titlerOptionKey(option),
			label: option.label,
			automatic: false,
			saved: option.saved,
			model: option.model,
			providerId: option.providerId,
		})),
	];

	const filtered = filterTitlerOptions(entries, open ? query : "");
	const safeActive =
		filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

	const selectedLabel =
		rows.selectionKey === AUTOMATIC_KEY
			? "Automatic (free)"
			: (entries.find((entry) => entry.key === rows.selectionKey)?.label ?? "");

	const openList = () => {
		setOpen(true);
		setQuery("");
		const idx = filtered.findIndex((entry) => entry.key === rows.selectionKey);
		setActiveIndex(idx >= 0 ? idx : 0);
	};

	const closeList = () => {
		setOpen(false);
		setQuery("");
	};

	const choose = (key: string): void => {
		if (key === AUTOMATIC_KEY) {
			setSettings(titlerSelectionPatch(undefined));
		} else {
			const option = rows.options.find(
				(candidate) => titlerOptionKey(candidate) === key,
			);
			if (option === undefined) return;
			const choice: TitlerModelChoice = {
				providerId: option.providerId,
				model: option.model,
			};
			setSettings(titlerSelectionPatch(choice));
		}
		closeList();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (!open) {
			if (
				event.key === "ArrowDown" ||
				event.key === "ArrowUp" ||
				event.key === "Enter"
			) {
				event.preventDefault();
				openList();
			}
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((index) =>
				Math.min(index + 1, Math.max(filtered.length - 1, 0)),
			);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((index) => Math.max(index - 1, 0));
		} else if (event.key === "Enter") {
			event.preventDefault();
			const entry = filtered[safeActive];
			if (entry !== undefined) choose(entry.key);
		} else if (event.key === "Escape") {
			event.preventDefault();
			closeList();
		}
	};

	return (
		<Section
			heading={
				<h3 id={SETTINGS_SECTIONS.titler.anchorId} className={SECTION_HEADING}>
					{SETTINGS_SECTIONS.titler.title}
				</h3>
			}
		>
			<p className="text-xs text-neutral-500">{rows.hint}</p>

			<label className={LABEL}>
				Model
				<input
					ref={inputRef}
					type="text"
					role="combobox"
					aria-label="Titler model"
					aria-expanded={open}
					aria-controls={listId}
					aria-activedescendant={
						open && filtered.length > 0
							? `titler-option-${safeActive}`
							: undefined
					}
					value={open ? query : selectedLabel}
					onChange={(event) => setQuery(event.target.value)}
					onFocus={() => openList()}
					onBlur={() => {
						setTimeout(() => {
							setOpen(false);
							setQuery("");
						}, 0);
					}}
					onKeyDown={onKeyDown}
					className={INPUT}
					placeholder="Automatic (free)"
				/>
				{open && (
					<div
						id={listId}
						role="listbox"
						className="mt-1 max-h-48 overflow-auto rounded-md border border-neutral-700 bg-neutral-900"
					>
						{filtered.map((entry, index) => (
							<Button
								key={entry.key}
								type="button"
								role="option"
								id={`titler-option-${index}`}
								aria-selected={entry.key === rows.selectionKey}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => choose(entry.key)}
								className={
									index === safeActive
										? "w-full text-left bg-neutral-700"
										: "w-full text-left"
								}
							>
								{entry.label}
							</Button>
						))}
					</div>
				)}
			</label>

			<p className="text-xs text-neutral-500">
				One call per new conversation, on the provider above — subject to that
				provider's own rate limits, and paid if you pick a paid model.
			</p>
		</Section>
	);
}
