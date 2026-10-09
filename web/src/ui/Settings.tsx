import type { Profile, ProviderConfig } from "@lib/db";
import { type ProtocolName, protocolNames } from "@lib/providers";
import { listModels, testModel } from "@lib/providers/models";
import { PROVIDER_PRESETS } from "@lib/providers/presets";
import { Effect } from "effect";
import { useState } from "react";
import {
	addProfile,
	addProvider,
	removeProfile,
	removeProvider,
	selectProvider,
	setSettings,
	updateProfile,
	updateProvider,
	useSettings,
} from "@/state/settings";

const INPUT =
	"rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

const LABEL =
	"flex flex-col gap-1 text-xs uppercase tracking-widest text-neutral-500";

const BUTTON =
	"rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40";

/** Only tool the UI exposes; the request body sends it verbatim. */
const WEB_SEARCH = "web_search_preview";
const DEFAULT_MAX_RESULTS = 5;
/** Sentinel for the preset select when no preset matches the provider. */
const CUSTOM_PRESET = "custom";

export default function Settings() {
	const settings = useSettings();
	const active = settings.providers.find(
		(provider) => provider.id === settings.activeProviderId,
	);

	// `editingId` only gates the edit form; the form always edits the active
	// provider (Edit/Add select it first), so every change writes to one entry.
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
	const [modelsPending, setModelsPending] = useState(false);
	const [testPending, setTestPending] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const missingKey = (active?.apiKey ?? "").trim() === "";
	const missingBaseUrl = (active?.baseUrl ?? "").trim() === "";

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

	const patchActive = (patch: Partial<Omit<ProviderConfig, "id">>): void => {
		if (active === undefined) return;
		updateProvider(active.id, patch);
	};

	const openEditor = (id: string): void => {
		selectProvider(id);
		setEditingId(id);
		setMessage(null);
	};

	const add = (): void => {
		const id = addProvider();
		setEditingId(id);
		setMessage(null);
	};

	const remove = (id: string): void => {
		removeProvider(id);
		if (editingId === id) setEditingId(null);
		setMessage(null);
	};

	const editingProfile = settings.profiles.find(
		(profile) => profile.id === editingProfileId,
	);

	const patchProfile = (patch: Partial<Omit<Profile, "id">>): void => {
		if (editingProfile === undefined) return;
		updateProfile(editingProfile.id, patch);
	};

	const addProfileEntry = (): void => {
		setEditingProfileId(addProfile());
	};

	const removeProfileEntry = (id: string): void => {
		removeProfile(id);
		if (editingProfileId === id) setEditingProfileId(null);
	};

	// Models offered for the profile's chosen provider, from its last fetch.
	const editingProfileModels =
		settings.providers.find(
			(provider) => provider.id === editingProfile?.providerId,
		)?.models ?? [];

	// Reflect the active preset by matching the provider; anything that does
	// not match a preset reads as "Custom".
	const activePreset =
		active === undefined
			? CUSTOM_PRESET
			: (PROVIDER_PRESETS.find(
					(preset) =>
						preset.baseUrl === active.baseUrl &&
						preset.protocol === active.protocol,
				)?.id ?? CUSTOM_PRESET);

	const selectPreset = (id: string): void => {
		if (id === CUSTOM_PRESET || active === undefined) return;
		const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === id);
		if (preset === undefined) return;
		patchActive({
			baseUrl: preset.baseUrl,
			protocol: preset.protocol,
			// Only fill a blank label, never overwrite a user's name.
			label: active.label.trim() === "" ? preset.label : active.label,
		});
	};

	const canFetch = active !== undefined && active.baseUrl.trim() !== "";
	const canTest = canFetch && (active?.model.trim() ?? "") !== "";
	const pending = modelsPending || testPending;

	/**
	 * "Fetch models" funnels the `listModels` string error channel into
	 * `setMessage` so nothing throws out of the component, caches the ids on the
	 * active provider, and clears the loading flag on success or failure alike.
	 */
	const fetchModels = (): void => {
		if (active === undefined || !canFetch) return;
		const id = active.id;
		setMessage(null);
		setModelsPending(true);
		Effect.runFork(
			listModels(active.baseUrl, active.apiKey).pipe(
				Effect.tap((ids) =>
					Effect.sync(() => updateProvider(id, { models: ids })),
				),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setModelsPending(false))),
			),
		);
	};

	const testConnection = (): void => {
		if (active === undefined || !canTest) return;
		const model = active.model;
		setMessage(null);
		setTestPending(true);
		Effect.runFork(
			testModel(active.protocol, active.baseUrl, active.apiKey, model).pipe(
				Effect.tap(() => Effect.sync(() => setMessage(`✓ ${model} responded`))),
				Effect.catch((error) => Effect.sync(() => setMessage(error))),
				Effect.ensuring(Effect.sync(() => setTestPending(false))),
			),
		);
	};

	const showEditor = editingId !== null && active !== undefined;

	return (
		<div className="flex-1 overflow-y-auto bg-neutral-950 px-4 py-6">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
				<h2 className="text-xs uppercase tracking-widest text-neutral-500">
					Settings
				</h2>
				{active === undefined ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-300">
						No provider configured — add one below to start sending.
					</div>
				) : null}
				{active !== undefined && missingKey ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-300">
						No API key set — sending is disabled until you add one below.
					</div>
				) : null}
				{active !== undefined && missingBaseUrl ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-300">
						No base URL set — sending is disabled until you add one below.
					</div>
				) : null}

				<div className="flex flex-col gap-3">
					<div className="flex items-center justify-between gap-3">
						<h3 className="text-xs uppercase tracking-widest text-neutral-500">
							Providers
						</h3>
						<button type="button" onClick={add} className={BUTTON}>
							Add provider
						</button>
					</div>
					{settings.providers.length === 0 ? (
						<p className="text-sm text-neutral-500">
							No providers yet — add one to start.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{settings.providers.map((provider) => {
								const isActive = provider.id === settings.activeProviderId;
								return (
									<li
										key={provider.id}
										className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
											isActive
												? "border-neutral-500 bg-neutral-900"
												: "border-neutral-800 bg-neutral-950"
										}`}
									>
										<button
											type="button"
											onClick={() => selectProvider(provider.id)}
											className="flex min-w-0 flex-1 flex-col items-start text-left"
										>
											<span className="flex items-center gap-2 truncate text-sm text-neutral-100">
												{provider.label.trim() !== ""
													? provider.label
													: "Untitled provider"}
												{isActive ? (
													<span className="text-xs uppercase tracking-widest text-emerald-400">
														active
													</span>
												) : null}
											</span>
											<span className="w-full truncate text-xs text-neutral-500">
												{provider.baseUrl.trim() !== ""
													? provider.baseUrl
													: "no base URL"}
											</span>
										</button>
										<button
											type="button"
											onClick={() => openEditor(provider.id)}
											className={BUTTON}
										>
											Edit
										</button>
										<button
											type="button"
											onClick={() => remove(provider.id)}
											className={BUTTON}
										>
											Remove
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				{showEditor && active !== undefined ? (
					<div className="flex flex-col gap-4 rounded-md border border-neutral-800 p-4">
						<p className="text-xs uppercase tracking-widest text-neutral-500">
							Editing active provider
						</p>
						<label className={LABEL}>
							Label
							<input
								type="text"
								value={active.label}
								onChange={(event) => patchActive({ label: event.target.value })}
								placeholder="OpenAI"
								className={INPUT}
							/>
						</label>
						<label className={LABEL}>
							Preset
							<select
								value={activePreset}
								onChange={(event) => selectPreset(event.target.value)}
								className={INPUT}
							>
								{PROVIDER_PRESETS.map((preset) => (
									<option key={preset.id} value={preset.id}>
										{preset.label}
									</option>
								))}
								<option value={CUSTOM_PRESET}>Custom</option>
							</select>
						</label>
						<label className={LABEL}>
							Protocol
							<select
								value={active.protocol}
								onChange={(event) =>
									patchActive({
										protocol: event.target.value as ProtocolName,
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
								value={active.baseUrl}
								onChange={(event) =>
									patchActive({ baseUrl: event.target.value })
								}
								placeholder="https://api.openai.com/v1"
								className={INPUT}
							/>
						</label>
						<label className={LABEL}>
							API key
							<input
								type="password"
								autoComplete="off"
								value={active.apiKey}
								onChange={(event) =>
									patchActive({ apiKey: event.target.value })
								}
								placeholder="sk-…"
								className={INPUT}
							/>
						</label>
						<label className={LABEL}>
							Model
							<input
								type="text"
								list="model-suggestions"
								value={active.model}
								onChange={(event) => patchActive({ model: event.target.value })}
								placeholder="gpt-4o-mini"
								className={INPUT}
							/>
						</label>
						<datalist id="model-suggestions">
							{active.models.map((id) => (
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
									className={`text-sm ${
										message.startsWith("✓") ? "text-green-400" : "text-red-400"
									}`}
								>
									{message}
								</span>
							) : null}
						</div>
					</div>
				) : null}

				<div className="flex flex-col gap-3 border-t border-neutral-800 pt-5">
					<div className="flex items-center justify-between gap-3">
						<h3 className="text-xs uppercase tracking-widest text-neutral-500">
							Profiles
						</h3>
						<button type="button" onClick={addProfileEntry} className={BUTTON}>
							Add profile
						</button>
					</div>
					{settings.profiles.length === 0 ? (
						<p className="text-sm text-neutral-500">
							No profiles yet — add one to bundle a provider, model and system
							prompt.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{settings.profiles.map((profile) => (
								<li
									key={profile.id}
									className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
								>
									<span className="flex min-w-0 flex-1 flex-col items-start text-left">
										<span className="w-full truncate text-sm text-neutral-100">
											{profile.name.trim() !== ""
												? profile.name
												: "Untitled profile"}
										</span>
										<span className="w-full truncate text-xs text-neutral-500">
											{profile.model.trim() !== "" ? profile.model : "no model"}
										</span>
									</span>
									<button
										type="button"
										onClick={() => setEditingProfileId(profile.id)}
										className={BUTTON}
									>
										Edit
									</button>
									<button
										type="button"
										onClick={() => removeProfileEntry(profile.id)}
										className={BUTTON}
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				{editingProfile !== undefined ? (
					<div className="flex flex-col gap-4 rounded-md border border-neutral-800 p-4">
						<p className="text-xs uppercase tracking-widest text-neutral-500">
							Editing profile
						</p>
						<label className={LABEL}>
							Name
							<input
								type="text"
								value={editingProfile.name}
								onChange={(event) => patchProfile({ name: event.target.value })}
								placeholder="Fast"
								className={INPUT}
							/>
						</label>
						<label className={LABEL}>
							Provider
							<select
								value={editingProfile.providerId}
								onChange={(event) =>
									patchProfile({ providerId: event.target.value })
								}
								className={INPUT}
							>
								<option value="">—</option>
								{settings.providers.map((provider) => (
									<option key={provider.id} value={provider.id}>
										{provider.label.trim() !== ""
											? provider.label
											: "Untitled provider"}
									</option>
								))}
							</select>
						</label>
						<label className={LABEL}>
							Model
							<input
								type="text"
								list="profile-model-suggestions"
								value={editingProfile.model}
								onChange={(event) =>
									patchProfile({ model: event.target.value })
								}
								placeholder="gpt-4o-mini"
								className={INPUT}
							/>
						</label>
						<datalist id="profile-model-suggestions">
							{editingProfileModels.map((id) => (
								<option key={id} value={id} />
							))}
						</datalist>
						<label className={LABEL}>
							System prompt
							<textarea
								rows={4}
								value={editingProfile.systemPrompt}
								onChange={(event) =>
									patchProfile({ systemPrompt: event.target.value })
								}
								placeholder="Instructions applied when this profile is picked…"
								className={INPUT}
							/>
						</label>
					</div>
				) : null}

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
