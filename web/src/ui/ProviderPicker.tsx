import { selectProvider, updateProvider, useSettings } from "@/state/settings";

const CONTROL =
	"max-w-[12rem] truncate rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-500 focus:outline-none";

/**
 * Chat-header provider + model pickers. The provider `<select>` drives the
 * active pointer; the model control writes the chosen model into the active
 * provider. Models come from the last "Fetch models" cache — when that is
 * empty there is nothing to choose from, so a free-text input stands in.
 */
export default function ProviderPicker() {
	const { providers, activeProviderId } = useSettings();
	const active = providers.find((provider) => provider.id === activeProviderId);

	const setModel = (model: string): void => {
		if (active === undefined) return;
		updateProvider(active.id, { model });
	};

	// A typed model that is absent from the fetched list still needs an option,
	// or the `<select>` would render blank and lose the current value.
	const modelOptions =
		active !== undefined &&
		active.model !== "" &&
		!active.models.includes(active.model)
			? [active.model, ...active.models]
			: (active?.models ?? []);

	return (
		<div className="flex items-center gap-2">
			<select
				aria-label="Provider"
				value={activeProviderId}
				onChange={(event) => selectProvider(event.target.value)}
				disabled={providers.length === 0}
				className={CONTROL}
			>
				{providers.length === 0 ? <option value="">No provider</option> : null}
				{providers.map((provider) => (
					<option key={provider.id} value={provider.id}>
						{provider.label.trim() !== ""
							? provider.label
							: "Untitled provider"}
					</option>
				))}
			</select>
			{active === undefined ? null : active.models.length > 0 ? (
				<select
					aria-label="Model"
					value={active.model}
					onChange={(event) => setModel(event.target.value)}
					className={CONTROL}
				>
					{active.model === "" ? (
						<option value="">Select a model…</option>
					) : null}
					{modelOptions.map((id) => (
						<option key={id} value={id}>
							{id}
						</option>
					))}
				</select>
			) : (
				<input
					type="text"
					aria-label="Model"
					value={active.model}
					onChange={(event) => setModel(event.target.value)}
					placeholder="model id"
					className={CONTROL}
				/>
			)}
		</div>
	);
}
