import { type Backup, exportBackup, importBackup } from "@lib/backup";
import type { MemoryNote, Profile, ProviderConfig } from "@lib/db";
import { MAX_MEMORY_NOTE_LENGTH, mergeMemories } from "@lib/memory";
import { type ProtocolName, protocolNames } from "@lib/providers";
import { listModels, testModel } from "@lib/providers/models";
import {
	isLocalEndpoint,
	PROVIDER_PRESETS,
	searchKindFor,
} from "@lib/providers/presets";
import { TINYFISH_API_KEYS_URL } from "@lib/tinyfish";
import { Effect } from "effect";
import { type ChangeEvent, useRef, useState } from "react";
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
import ConfirmButton from "@/ui/ConfirmButton";

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
	const [backupStatus, setBackupStatus] = useState<{
		readonly ok: boolean;
		readonly text: string;
	} | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);

	const missingKey =
		!isLocalEndpoint(active?.baseUrl ?? "") &&
		(active?.apiKey ?? "").trim() === "";
	const missingBaseUrl = (active?.baseUrl ?? "").trim() === "";

	const patchActive = (patch: Partial<Omit<ProviderConfig, "id">>): void => {
		if (active === undefined) return;
		updateProvider(active.id, patch);
	};

	// Tools are per-provider: the toggle edits the ACTIVE provider's
	// `tools`. Enabled = a non-empty tools array; the endpoint's own
	// search executes it where one exists, and TinyFish's client-side
	// web_search does so where none does (a key is required).
	const activeTools = active?.tools ?? [];
	const searchKind = searchKindFor(active?.baseUrl ?? "");
	const webSearch = activeTools.length > 0;
	// A TinyFish key serves search where the endpoint has none, so
	// it keeps the toggle live on such an endpoint.
	const tinyfishKey = settings.tinyfishApiKey.trim();
	const maxNumResults =
		activeTools.find((tool) => tool.type === WEB_SEARCH)?.max_num_results ??
		DEFAULT_MAX_RESULTS;

	const setWebSearch = (on: boolean): void => {
		patchActive({
			tools: on ? [{ type: WEB_SEARCH, max_num_results: maxNumResults }] : [],
		});
	};

	const setFetchToolEnabled = (on: boolean): void => {
		setSettings({ fetchToolEnabled: on });
	};

	const setMaxResults = (raw: string): void => {
		const value = Number.parseInt(raw, 10);
		if (!Number.isFinite(value)) return;
		patchActive({ tools: [{ type: WEB_SEARCH, max_num_results: value }] });
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
			// Presets carry their endpoint's default tools (empty where the
			// built-in is rejected).
			tools: [...(preset.tools ?? [])],
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
			listModels(active.protocol, active.baseUrl, active.apiKey).pipe(
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

	/** Identical bytes for the download and the clipboard copy. */
	const serializeBackup = (backup: Backup): string =>
		`${JSON.stringify(backup, null, 2)}\n`;

	/** Download the backup as `ai-client-backup-<YYYY-MM-DD>.json`. */
	const exportBackupFile = (): void => {
		Effect.runFork(
			exportBackup().pipe(
				Effect.tap((backup) =>
					Effect.sync(() => {
						const blob = new Blob([serializeBackup(backup)], {
							type: "application/json",
						});
						const url = URL.createObjectURL(blob);
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.download = `ai-client-backup-${new Date()
							.toISOString()
							.slice(0, 10)}.json`;
						anchor.click();
						URL.revokeObjectURL(url);
					}),
				),
				Effect.catch((error) =>
					Effect.sync(() => setBackupStatus({ ok: false, text: error })),
				),
			),
		);
	};

	/**
	 * Copy the same JSON — the desktop webview may not surface a
	 * download, so this is the other half of export.
	 */
	const copyBackupJson = (): void => {
		Effect.runFork(
			exportBackup().pipe(
				Effect.tap((backup) =>
					Effect.tryPromise({
						try: () => navigator.clipboard.writeText(serializeBackup(backup)),
						catch: (cause) => String(cause),
					}),
				),
				Effect.tap(() =>
					Effect.sync(() =>
						setBackupStatus({
							ok: true,
							text: "Copied backup JSON to the clipboard.",
						}),
					),
				),
				Effect.catch((error) =>
					Effect.sync(() => setBackupStatus({ ok: false, text: error })),
				),
			),
		);
	};

	/**
	 * Read the picked file as text. `FileReader` is a callback-based
	 * Web API, so `Effect.callback` keeps it inside Effect without a
	 * raw `Promise` (banned in `web/src` by the `no-new-promise`
	 * plugin).
	 */
	const readBackupFile = (file: File): Effect.Effect<unknown, string> =>
		Effect.callback<string, string>((resume) => {
			const reader = new FileReader();
			reader.onload = () => resume(Effect.succeed(String(reader.result ?? "")));
			reader.onerror = () =>
				resume(Effect.fail(String(reader.error ?? "file read failed")));
			reader.readAsText(file);
		}).pipe(
			Effect.flatMap((text) =>
				Effect.try({
					try: () => JSON.parse(text),
					catch: (cause) => String(cause),
				}),
			),
		);

	const onImportFile = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];
		if (file !== undefined) {
			Effect.runFork(
				readBackupFile(file).pipe(
					Effect.flatMap((raw) => importBackup(raw)),
					Effect.tap((result) =>
						Effect.sync(() => {
							setBackupStatus({
								ok: true,
								text: `Imported ${result.conversations} conversations.`,
							});
							// Both stores re-hydrate from `db` on the
							// fresh load; no partial in-memory state.
							window.location.reload();
						}),
					),
					Effect.catch((error) =>
						Effect.sync(() => setBackupStatus({ ok: false, text: error })),
					),
				),
			);
		}
		// Reset so re-selecting the same file fires `change` again.
		event.target.value = "";
	};

	const [memoryDraft, setMemoryDraft] = useState("");

	const setMemoriesEnabled = (on: boolean): void => {
		setSettings({ memoriesEnabled: on });
	};

	/**
	 * Add a user-typed note through the same merge as the model path, then
	 * re-stamp the added note `source: "user"` (the merge stamps its additions
	 * "model"). Identity, not position, decides what is new: a duplicate adds
	 * nothing and the cap evicts the oldest.
	 */
	const addMemory = (): void => {
		const text = memoryDraft.trim();
		if (text === "") return;
		const existingIds = new Set(settings.memories.map((note) => note.id));
		const merged: MemoryNote[] = mergeMemories(
			settings.memories,
			[text],
			Date.now(),
		).map((note) =>
			existingIds.has(note.id) ? note : { ...note, source: "user" as const },
		);
		setSettings({ memories: merged });
		setMemoryDraft("");
	};

	const removeMemory = (id: string): void => {
		setSettings({
			memories: settings.memories.filter((note) => note.id !== id),
		});
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
				{active !== undefined && isLocalEndpoint(active.baseUrl) ? (
					<p className="text-xs text-neutral-500">
						Local endpoint: no API key needed. A browser page still needs the
						server to allow this origin (e.g. OLLAMA_ORIGINS) — the desktop
						build has no such limit.
					</p>
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
										<ConfirmButton
											label="Remove"
											confirmLabel="Confirm?"
											onConfirm={() => remove(provider.id)}
											className={BUTTON}
										/>
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
								placeholder="OpenAI-compatible"
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
									<ConfirmButton
										label="Remove"
										confirmLabel="Confirm?"
										onConfirm={() => removeProfileEntry(profile.id)}
										className={BUTTON}
									/>
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
							disabled={
								active === undefined ||
								(searchKind === null && tinyfishKey === "")
							}
							onChange={(event) => setWebSearch(event.target.checked)}
							className="h-4 w-4 accent-neutral-300 disabled:opacity-40"
						/>
					</label>
					{searchKind === null ? (
						<p className="text-xs text-neutral-500">
							This endpoint has no server-side web search
							{tinyfishKey === ""
								? "."
								: " — with a TinyFish key set, search runs through TinyFish (free within its daily allowance)."}
						</p>
					) : searchKind === "openrouter" ? (
						<p className="text-xs text-neutral-500">
							OpenRouter&apos;s search server tool lets the model decide when to
							search (billed by OpenRouter).
						</p>
					) : searchKind === "anthropic" ? (
						<p className="text-xs text-neutral-500">
							Anthropic executes its built-in web_search server tool on its own
							API (billed by Anthropic).
						</p>
					) : (
						<p className="text-xs text-neutral-500">
							Applies only to the active provider — OpenAI executes its built-in
							search tool on its own API.
						</p>
					)}
					{webSearch && searchKind !== null ? (
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
					<label className="flex items-center justify-between gap-3 text-xs uppercase tracking-widest text-neutral-500">
						Page fetch
						<input
							type="checkbox"
							checked={settings.fetchToolEnabled}
							onChange={(event) => setFetchToolEnabled(event.target.checked)}
							className="h-4 w-4 accent-neutral-300"
						/>
					</label>
					<p className="text-xs text-neutral-500">
						With this on, every request declares the built-in fetch_url tool, so
						the model can read a page you link. The desktop app fetches it
						directly; the browser build is bound by cross-origin rules.
					</p>
					<label className={LABEL}>
						TinyFish API key
						<input
							type="password"
							autoComplete="off"
							value={settings.tinyfishApiKey}
							onChange={(event) =>
								setSettings({ tinyfishApiKey: event.target.value })
							}
							placeholder="TinyFish key"
							className={INPUT}
						/>
					</label>
					<p className="text-xs text-neutral-500">
						Search and page fetch run through TinyFish while a key is set — free
						within a daily allowance. The client-side web_search tool is
						declared where the endpoint has no search of its own, and fetch_url
						reads through TinyFish first. Get a key at{" "}
						<a
							href={TINYFISH_API_KEYS_URL}
							target="_blank"
							rel="noreferrer noopener"
							className="text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
						>
							agent.tinyfish.ai/api-keys
						</a>
						.
					</p>
				</div>
				<div className="flex flex-col gap-3 border-t border-neutral-800 pt-5">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h3 className="text-xs uppercase tracking-widest text-neutral-500">
							Memory
						</h3>
						<label className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
							Enabled
							<input
								type="checkbox"
								checked={settings.memoriesEnabled}
								onChange={(event) => setMemoriesEnabled(event.target.checked)}
								className="h-4 w-4 accent-neutral-300"
							/>
						</label>
					</div>
					<p className="text-xs text-neutral-500">
						One list of durable facts for every chat, sent with each request.
						The model can save notes in its replies; you can add or remove them
						here.
					</p>
					{settings.memories.length === 0 ? (
						<p className="text-sm text-neutral-500">No memories yet.</p>
					) : (
						<ul className="flex flex-col gap-2">
							{[...settings.memories].reverse().map((note) => (
								<li
									key={note.id}
									className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
								>
									<span className="flex min-w-0 flex-1 flex-col items-start text-left">
										<span className="w-full text-sm text-neutral-100">
											{note.text}
										</span>
										<span className="w-full truncate text-xs text-neutral-500">
											{note.source === "model" ? "from the model" : "yours"} ·{" "}
											{new Date(note.createdAt).toLocaleDateString()}
										</span>
									</span>
									<ConfirmButton
										label="Delete"
										confirmLabel="Confirm?"
										onConfirm={() => removeMemory(note.id)}
										className={BUTTON}
									/>
								</li>
							))}
						</ul>
					)}
					<form
						className="flex gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							addMemory();
						}}
					>
						<input
							type="text"
							value={memoryDraft}
							maxLength={MAX_MEMORY_NOTE_LENGTH}
							onChange={(event) => setMemoryDraft(event.target.value)}
							placeholder="Remember that…"
							className={INPUT}
						/>
						<button
							type="submit"
							disabled={memoryDraft.trim() === ""}
							className={BUTTON}
						>
							Add
						</button>
					</form>
				</div>
				<div className="flex flex-col gap-3 border-t border-neutral-800 pt-5">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h3 className="text-xs uppercase tracking-widest text-neutral-500">
							Backup
						</h3>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={exportBackupFile}
								className={BUTTON}
							>
								Export
							</button>
							<button type="button" onClick={copyBackupJson} className={BUTTON}>
								Copy
							</button>
							<button
								type="button"
								onClick={() => importInputRef.current?.click()}
								className={BUTTON}
							>
								Import
							</button>
						</div>
					</div>
					<input
						ref={importInputRef}
						type="file"
						accept="application/json,.json"
						onChange={onImportFile}
						className="hidden"
					/>
					<p className="text-xs text-neutral-500">
						Move settings and conversations between the desktop app and the
						website as a JSON file. The file contains your API keys — keep it
						private.
					</p>
					{backupStatus !== null ? (
						<span
							className={`text-sm ${
								backupStatus.ok ? "text-green-400" : "text-red-400"
							}`}
						>
							{backupStatus.text}
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}
