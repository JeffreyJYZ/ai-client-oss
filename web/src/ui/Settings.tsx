import { type ProtocolName, protocolNames } from "@lib/providers";
import { listModels, testModel } from "@lib/providers/models";
import { Effect } from "effect";
import { useState } from "react";
import { setSettings, useSettings } from "@/state/settings";

const INPUT =
	"rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

const LABEL =
	"flex flex-col gap-1 text-xs uppercase tracking-widest text-neutral-500";

const BUTTON =
	"rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40";

/** Only tool the UI exposes; the request body sends it verbatim. */
const WEB_SEARCH = "web_search_preview";
const DEFAULT_MAX_RESULTS = 5;

export default function Settings() {
	const settings = useSettings();
	const missingKey = settings.apiKey.trim() === "";
	const missingBaseUrl = settings.baseUrl.trim() === "";

	// Model suggestions for the free-text input, plus the fetch/test status.
	const [models, setModels] = useState<string[]>([]);
	const [modelsPending, setModelsPending] = useState(false);
	const [testPending, setTestPending] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

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

	const canFetch = settings.baseUrl.trim() !== "";
	const canTest = canFetch && settings.model.trim() !== "";
	const pending = modelsPending || testPending;

	/**
	 * Runner for "Fetch models": funnels the `listModels` string error channel
	 * into `setMessage` so nothing throws out of the component, and clears the
	 * loading flag on success or failure alike.
	 */
	const runModels = (
		setPending: (value: boolean) => void,
		onModels: (ids: string[]) => void,
	): void => {
		setPending(true);
		Effect.runFork(
			listModels(settings.baseUrl, settings.apiKey).pipe(
				Effect.tap((ids) => Effect.sync(() => onModels(ids))),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setPending(false))),
			),
		);
	};

	const fetchModels = (): void => {
		if (!canFetch) return;
		setMessage(null);
		runModels(setModelsPending, setModels);
	};

	const testConnection = (): void => {
		if (!canTest) return;
		const model = settings.model;
		setMessage(null);
		setTestPending(true);
		Effect.runFork(
			testModel(
				settings.provider,
				settings.baseUrl,
				settings.apiKey,
				model,
			).pipe(
				Effect.tap(() => Effect.sync(() => setMessage(`✓ ${model} responded`))),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setTestPending(false))),
			),
		);
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
				{missingBaseUrl ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-300">
						No base URL set — sending is disabled until you add one below.
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
						list="model-suggestions"
						value={settings.model}
						onChange={(event) => setSettings({ model: event.target.value })}
						placeholder="gpt-4o-mini"
						className={INPUT}
					/>
				</label>
				<datalist id="model-suggestions">
					{models.map((id) => (
						<option key={id} value={id} />
					))}
				</datalist>
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={fetchModels}
						disabled={!canFetch || pending}
						className={BUTTON}
					>
						{modelsPending ? "Fetching…" : "Fetch models"}
					</button>
					<button
						type="button"
						onClick={testConnection}
						disabled={!canTest || pending}
						className={BUTTON}
					>
						{testPending ? "Testing…" : "Test connection"}
					</button>
					{message !== null ? (
						<span
							className={`text-sm ${message.startsWith("✓") ? "text-green-400" : "text-red-400"}`}
						>
							{message}
						</span>
					) : null}
				</div>
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
