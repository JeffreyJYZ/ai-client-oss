import { type ProtocolName, protocolNames } from "@lib/providers";
import { setSettings, useSettings } from "@/state/settings";

const INPUT =
	"rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

const LABEL =
	"flex flex-col gap-1 text-xs uppercase tracking-widest text-neutral-500";

/** Only tool the UI exposes; the request body sends it verbatim. */
const WEB_SEARCH = "web_search_preview";
const DEFAULT_MAX_RESULTS = 5;

export default function Settings() {
	const settings = useSettings();
	const missingKey = settings.apiKey.trim() === "";

	// Enabled = a non-empty tools array (the shape the store/db persists).
	const webSearch = settings.tools.length > 0;
	const maxNumResults =
		settings.tools.find((tool) => tool.type === WEB_SEARCH)?.max_num_results ??
		DEFAULT_MAX_RESULTS;

	const setWebSearch = (on: boolean): void => {
		setSettings({
			tools: on ? [{ type: WEB_SEARCH, max_num_results: maxNumResults }] : [],
		});
	};

	const setMaxResults = (raw: string): void => {
		const value = Number.parseInt(raw, 10);
		if (!Number.isFinite(value)) return;
		setSettings({ tools: [{ type: WEB_SEARCH, max_num_results: value }] });
	};

	return (
		<div className="flex-1 overflow-y-auto bg-neutral-950 px-4 py-6">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
				<h2 className="text-xs uppercase tracking-widest text-neutral-500">
					Settings
				</h2>
				{missingKey ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-300">
						No API key set — sending is disabled until you add one below.
					</div>
				) : null}
				<label className={LABEL}>
					Provider
					<select
						value={settings.provider}
						onChange={(event) =>
							setSettings({
								provider: event.target.value as ProtocolName,
							})
						}
						className={INPUT}
					>
						{protocolNames.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
				</label>
				<label className={LABEL}>
					Base URL
					<input
						type="text"
						value={settings.baseUrl}
						onChange={(event) => setSettings({ baseUrl: event.target.value })}
						placeholder="https://api.openai.com/v1"
						className={INPUT}
					/>
				</label>
				<label className={LABEL}>
					API key
					<input
						type="password"
						autoComplete="off"
						value={settings.apiKey}
						onChange={(event) => setSettings({ apiKey: event.target.value })}
						placeholder="sk-…"
						className={INPUT}
					/>
				</label>
				<label className={LABEL}>
					Model
					<input
						type="text"
						value={settings.model}
						onChange={(event) => setSettings({ model: event.target.value })}
						placeholder="gpt-4o-mini"
						className={INPUT}
					/>
				</label>
				<div className="flex flex-col gap-3 border-t border-neutral-800 pt-5">
					<label className="flex items-center justify-between gap-3 text-xs uppercase tracking-widest text-neutral-500">
						Web search
						<input
							type="checkbox"
							checked={webSearch}
							onChange={(event) => setWebSearch(event.target.checked)}
							className="h-4 w-4 accent-neutral-300"
						/>
					</label>
					{webSearch ? (
						<label className={LABEL}>
							Max results
							<input
								type="number"
								min={1}
								value={maxNumResults}
								onChange={(event) => setMaxResults(event.target.value)}
								className={INPUT}
							/>
						</label>
					) : null}
				</div>
			</div>
		</div>
	);
}
