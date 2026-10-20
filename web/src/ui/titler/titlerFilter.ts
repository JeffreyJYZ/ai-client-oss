/**
 * The Titler picker's filter — pure, so the combobox's behaviour is a value in
 * and a value out (the repo has no React renderer harness).
 *
 * A query is matched case-insensitively against what a user can see and type:
 * the option's label (which carries the provider's label and the model id), the
 * model id itself, and the provider id. An empty or whitespace-only query lists
 * everything.
 *
 * Two entries survive **every** query, because hiding them would hide a state
 * the picker exists to show: the "Automatic (free)" default, and the saved
 * override — a model chosen earlier that the provider's cached list no longer
 * carries. A picker that filtered the saved one away would render blank and
 * read as a lost choice.
 */

/** The shape a pickable option has; `TitlerOption` satisfies it. */
export interface TitlerPickerEntry {
	readonly key: string;
	readonly label: string;
	/** The "Automatic (free)" entry, which is always listed. */
	readonly automatic?: boolean;
	/** The saved override, which is always listed (see above). */
	readonly saved?: boolean;
	readonly model?: string;
	readonly providerId?: string;
}

export const filterTitlerOptions = <T extends TitlerPickerEntry>(
	options: readonly T[],
	query: string,
): readonly T[] => {
	const needle = query.trim().toLowerCase();
	if (needle === "") return options;
	return options.filter(
		(option) =>
			option.automatic === true ||
			option.saved === true ||
			option.label.toLowerCase().includes(needle) ||
			(option.model ?? "").toLowerCase().includes(needle) ||
			(option.providerId ?? "").toLowerCase().includes(needle),
	);
};
