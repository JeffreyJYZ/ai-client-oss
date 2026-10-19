import { isDesktop } from "@lib/platform";
import { resolveTitlerModel } from "@lib/titler";
import { getTitlerOutcome, subscribeTitlerOutcome } from "@lib/titlerStatus";
import { useSyncExternalStore } from "react";
import { setSettings, useSettings } from "@/state/settings";
import { CONTROL, Section } from "@/ui/kit";
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

	/** A `<select>` value back to the choice it names. */
	const choose = (key: string): void => {
		if (key === AUTOMATIC_KEY) {
			setSettings(titlerSelectionPatch(undefined));
			return;
		}
		const option = rows.options.find(
			(candidate) => titlerOptionKey(candidate) === key,
		);
		if (option === undefined) return;
		const choice: TitlerModelChoice = {
			providerId: option.providerId,
			model: option.model,
		};
		setSettings(titlerSelectionPatch(choice));
	};

	return (
		<Section
			heading={
				<h3 className="text-xs uppercase tracking-widest text-neutral-500">
					Titler
				</h3>
			}
		>
			<p className="text-xs text-neutral-500">{rows.hint}</p>

			<label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-neutral-500">
				Model
				<select
					aria-label="Titler model"
					value={rows.selectionKey}
					onChange={(event) => choose(event.target.value)}
					className={CONTROL}
				>
					<option value={AUTOMATIC_KEY}>Automatic (free)</option>
					{rows.options.map((option) => (
						<option
							key={titlerOptionKey(option)}
							value={titlerOptionKey(option)}
						>
							{option.label}
						</option>
					))}
				</select>
			</label>

			<p className="text-xs text-neutral-500">
				One call per new conversation, on the provider above — subject to that
				provider's own rate limits, and paid if you pick a paid model.
			</p>
		</Section>
	);
}
