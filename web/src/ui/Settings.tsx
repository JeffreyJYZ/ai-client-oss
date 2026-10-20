import {
	downloadBackup,
	exportBackup,
	importBackup,
	serializeBackup,
} from "@lib/backup";
import {
	clearPreMigrationCapture,
	db,
	getPreMigrationCapture,
	type Profile,
	type ProviderConfig,
} from "@lib/db";
import { isDesktop } from "@lib/platform";
import { protocolNames } from "@lib/plugins/providers";
import { runtime } from "@lib/plugins/runtime";
import { listModels, probeConnection } from "@lib/providers/models";
import {
	isLocalEndpoint,
	PROVIDER_PRESETS,
	searchKindFor,
} from "@lib/providers/presets";
import { TINYFISH_API_KEYS_URL } from "@lib/tinyfish";
import { Effect, Option } from "effect";
import {
	type ChangeEvent,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { LATEST_RELEASE_URL } from "@/constants/links";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
import { openReleaseNotes } from "@/state/releaseNotes";
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
import { checkForUpdates, installNow, useUpdates } from "@/state/updates";
import ConfirmButton from "@/ui/ConfirmButton";
import {
	BUTTON,
	INPUT,
	LABEL,
	SECTION,
	SECTION_HEADING,
	SECTION_SUMMARY,
	SECTION_SUMMARY_WRAP,
	Section,
} from "@/ui/kit";
import { SettingsNav } from "@/ui/SettingsNav";
import Slot from "@/ui/slots/Slot";

/** Only tool the UI exposes; the request body sends it verbatim. */
const WEB_SEARCH = "web_search_preview";
const DEFAULT_MAX_RESULTS = 5;
/** Sentinel for the preset select when no preset matches the provider. */
const CUSTOM_PRESET = "custom";

/**
 * The little bit of state the editor pairs share: the Providers list has to
 * open the provider editor, the Profiles list the profile editor, and every
 * mutation clears the transient status line the editors render. Splitting the
 * `<details>` sections into separate `settings.sections` contributions moves
 * each pair into two components, so this is the seam that keeps that state in
 * one place (the shell, {@link SettingsShell}) rather than duplicating it.
 *
 * It is a context, not a second store: absent a provider (a plugin replacing
 * `settings.root`), the sections degrade — the lists still render, the editors
 * simply never open — instead of crashing.
 */
interface EditorState {
	readonly editingId: string | null;
	readonly setEditingId: (id: string | null) => void;
	readonly editingProfileId: string | null;
	readonly setEditingProfileId: (id: string | null) => void;
	readonly message: string | null;
	readonly setMessage: (message: string | null) => void;
}

const EditorContext = createContext<EditorState | null>(null);

const useEditor = (): EditorState | null => useContext(EditorContext);

/** Holds the editor pair state for the section contributions below it. */
function EditorProvider({ children }: { readonly children: ReactNode }) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const value: EditorState = {
		editingId,
		setEditingId,
		editingProfileId,
		setEditingProfileId,
		message,
		setMessage,
	};
	return (
		<EditorContext.Provider value={value}>{children}</EditorContext.Provider>
	);
}

/**
 * The Settings page itself, registered at `settings.root`; the sections below
 * render into the nested `settings.sections` (the `settings.nav` slot is empty
 * of built-ins — it exists for plugins). Wrapping the sections in
 * {@link EditorProvider} keeps the page's per-editor state next to the page
 * chrome, exactly where it lived when this was one component.
 */
export function SettingsShell() {
	return (
		<div className="flex-1 overflow-y-auto bg-neutral-950 px-4 py-6">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
				<h2 className="text-xs uppercase tracking-widest text-neutral-500">
					Settings
				</h2>
				<EditorProvider>
					<SettingsNav />
					<Slot id="settings.nav" />
					<Slot id="settings.sections" />
				</EditorProvider>
			</div>
		</div>
	);
}

/**
 * The page's warning banners and the local-endpoint note, registered at
 * `settings.sections` so a plugin can reorder or hide them like any other
 * section (spec §4). Each derives its own condition from the settings store.
 */
export function SettingsNotices() {
	const settings = useSettings();
	const active = settings.providers.find(
		(provider) => provider.id === settings.activeProviderId,
	);
	const missingKey =
		!isLocalEndpoint(active?.baseUrl ?? "") &&
		(active?.apiKey ?? "").trim() === "";
	const missingBaseUrl = (active?.baseUrl ?? "").trim() === "";

	return (
		<>
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
					server to allow this origin (e.g. OLLAMA_ORIGINS) — the desktop build
					has no such limit.
				</p>
			) : null}
		</>
	);
}

/** The provider list and its "Add provider" control (`settings.sections`). */
export function ProviderSection() {
	const settings = useSettings();
	const editor = useEditor();

	const openEditor = (id: string): void => {
		selectProvider(id);
		editor?.setEditingId(id);
		editor?.setMessage(null);
	};

	const add = (): void => {
		const id = addProvider();
		editor?.setEditingId(id);
		editor?.setMessage(null);
	};

	const remove = (id: string): void => {
		removeProvider(id);
		if (editor?.editingId === id) editor.setEditingId(null);
		editor?.setMessage(null);
	};

	return (
		<Section
			className="flex flex-col gap-3"
			summaryClassName={SECTION_SUMMARY}
			heading={
				<>
					<h3
						id={SETTINGS_SECTIONS.providers.anchorId}
						className={SECTION_HEADING}
					>
						{SETTINGS_SECTIONS.providers.title}
					</h3>
					<button type="button" onClick={add} className={BUTTON}>
						Add provider
					</button>
				</>
			}
		>
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
		</Section>
	);
}

/**
 * The active provider's edit form, registered at `settings.sections` as its own
 * contribution so a plugin can reorder or hide it independently. It opens when
 * {@link ProviderSection} sets the shared `editingId`, and edits the active
 * provider (Edit/Add select it first), so every change writes to one entry.
 */
export function ProviderEditor() {
	const settings = useSettings();
	const editor = useEditor();
	const active = settings.providers.find(
		(provider) => provider.id === settings.activeProviderId,
	);
	const [modelsPending, setModelsPending] = useState(false);
	const [testPending, setTestPending] = useState(false);

	const message = editor?.message ?? null;

	const patchActive = (patch: Partial<Omit<ProviderConfig, "id">>): void => {
		if (active === undefined) return;
		updateProvider(active.id, patch);
	};

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
		editor?.setMessage(null);
		setModelsPending(true);
		runtime.runFork(
			listModels(active.protocol, active.baseUrl, active.apiKey).pipe(
				Effect.tap((ids) =>
					Effect.sync(() => updateProvider(id, { models: ids })),
				),
				Effect.catch((error) => Effect.sync(() => editor?.setMessage(error))),
				Effect.ensuring(Effect.sync(() => setModelsPending(false))),
			),
		);
	};

	/**
	 * "Test connection" shows the probe's one line — a success tick or a
	 * readable failure. `probeConnection` never fails: it catches a plugin
	 * protocol's typed failure **and** a defect, which this button's old typed
	 * `Effect.catch` missed (a protocol whose `headers` threw escaped it, so
	 * only `ensuring` ran and the user saw nothing).
	 */
	const testConnection = (): void => {
		if (active === undefined || !canTest) return;
		const model = active.model;
		editor?.setMessage(null);
		setTestPending(true);
		runtime.runFork(
			probeConnection(
				active.protocol,
				active.baseUrl,
				active.apiKey,
				model,
			).pipe(
				Effect.tap((message) => Effect.sync(() => editor?.setMessage(message))),
				Effect.ensuring(Effect.sync(() => setTestPending(false))),
			),
		);
	};

	const showEditor = editor?.editingId != null && active !== undefined;
	if (!showEditor || active === undefined) return null;

	return (
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
							protocol: event.target.value,
						})
					}
					className={INPUT}
				>
					{protocolNames().map((name) => (
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
					onChange={(event) => patchActive({ baseUrl: event.target.value })}
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
					onChange={(event) => patchActive({ apiKey: event.target.value })}
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
	);
}

/** The profile list and its "Add profile" control (`settings.sections`). */
export function ProfilesSection() {
	const settings = useSettings();
	const editor = useEditor();

	const addProfileEntry = (): void => {
		editor?.setEditingProfileId(addProfile());
	};

	const removeProfileEntry = (id: string): void => {
		removeProfile(id);
		if (editor?.editingProfileId === id) editor.setEditingProfileId(null);
	};

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY}
			heading={
				<>
					<h3
						id={SETTINGS_SECTIONS.profiles.anchorId}
						className={SECTION_HEADING}
					>
						{SETTINGS_SECTIONS.profiles.title}
					</h3>
					<button type="button" onClick={addProfileEntry} className={BUTTON}>
						Add profile
					</button>
				</>
			}
		>
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
								onClick={() => editor?.setEditingProfileId(profile.id)}
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
		</Section>
	);
}

/** The editing profile's form, registered as its own `settings.sections` entry. */
export function ProfileEditor() {
	const settings = useSettings();
	const editor = useEditor();

	const editingProfile = settings.profiles.find(
		(profile) => profile.id === editor?.editingProfileId,
	);

	const patchProfile = (patch: Partial<Omit<Profile, "id">>): void => {
		if (editingProfile === undefined) return;
		updateProfile(editingProfile.id, patch);
	};

	// Models offered for the profile's chosen provider, from its last fetch.
	const editingProfileModels =
		settings.providers.find(
			(provider) => provider.id === editingProfile?.providerId,
		)?.models ?? [];

	if (editingProfile === undefined) return null;

	return (
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
					onChange={(event) => patchProfile({ providerId: event.target.value })}
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
					onChange={(event) => patchProfile({ model: event.target.value })}
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
	);
}

/** The web-search / page-fetch / TinyFish block (`settings.sections`). */
export function WebSearchSection() {
	const settings = useSettings();
	const active = settings.providers.find(
		(provider) => provider.id === settings.activeProviderId,
	);

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

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY}
			heading={
				<label
					id={SETTINGS_SECTIONS.webSearch.anchorId}
					className="flex items-center justify-between gap-3 text-xs uppercase tracking-widest text-neutral-500"
				>
					{SETTINGS_SECTIONS.webSearch.title}
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
			}
		>
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
					Anthropic executes its built-in web_search server tool on its own API
					(billed by Anthropic).
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
				With this on, every request declares the built-in fetch_url tool, so the
				model can read a page you link. The desktop app fetches it directly; the
				browser build is bound by cross-origin rules.
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
				within a daily allowance. The client-side web_search tool is declared
				where the endpoint has no search of its own, and fetch_url reads through
				TinyFish first. Get a key at{" "}
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
		</Section>
	);
}

/** The durable-memory section moved to `ui/memory/MemorySection.tsx`: it is
 *  registered by the `app.memory` area (`lib/plugins/builtin/memory.ts`), not
 *  by this file's area, so the whole memory feature is one toggle. */

/** The backup export/import block, with its banners (`settings.sections`). */
export function BackupSection() {
	const [backupStatus, setBackupStatus] = useState<{
		readonly ok: boolean;
		readonly text: string;
	} | null>(null);
	/**
	 * Raw text of a stored settings blob that failed to parse, or `null` when
	 * the store is readable. Non-null shows the preservation banner, which is
	 * the only place the user learns the file was left alone.
	 */
	const [unreadableSettings, setUnreadableSettings] = useState<string | null>(
		null,
	);
	/**
	 * Raw pre-migration settings blob the composition root captured, or `null`.
	 * Non-null shows the download control in the Backup section, so the
	 * pre-upgrade values stay reachable (spec §13).
	 */
	const [preMigration, setPreMigration] = useState<string | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);

	// Re-read the rejection and the pre-migration capture on every render: the
	// settings store records both during its own (async) hydration, which may
	// settle after this view mounts. The values stabilise, so this does not loop.
	useEffect(() => {
		Effect.runFork(
			Effect.map(db.rejectedSettings(), (raw) =>
				setUnreadableSettings(Option.getOrNull(raw)),
			),
		);
		setPreMigration(getPreMigrationCapture());
	});

	/**
	 * Download the backup as `ai-client-backup-<YYYY-MM-DD>.json`. The bytes and
	 * the filename come from `lib/backup.ts`, shared with the
	 * `app.backup.export` command, so the two entry points cannot drift. Only the
	 * banner below is this section's own.
	 */
	const exportBackupFile = (): void => {
		Effect.runFork(
			exportBackup().pipe(
				Effect.tap((backup) => Effect.sync(() => downloadBackup(backup))),
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
	 * Download the pre-migration settings snapshot the composition root took,
	 * then drop it — the user asked for the copy, so it is no longer needed.
	 */
	const downloadPreMigration = (): void => {
		if (preMigration === null) return;
		const blob = new Blob([preMigration], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "ai-client-settings-pre-migration.json";
		anchor.click();
		URL.revokeObjectURL(url);
		clearPreMigrationCapture();
		setPreMigration(null);
	};

	/** Download the raw, unreadable settings text so nothing is lost. */
	const downloadUnreadableSettings = (): void => {
		if (unreadableSettings === null) return;
		const blob = new Blob([unreadableSettings], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "ai-client-settings-unreadable.json";
		anchor.click();
		URL.revokeObjectURL(url);
	};

	/**
	 * The user's explicit "start fresh": clear the rejection, then rewrite the
	 * store from the app's live settings so a valid blob replaces the
	 * unreadable one. Without the write the banner would return on next boot.
	 */
	const resetUnreadableSettings = (): void => {
		Effect.runFork(
			db.resetRejectedSettings().pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						setUnreadableSettings(null);
						setSettings({});
					}),
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

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY_WRAP}
			heading={
				<>
					<h3
						id={SETTINGS_SECTIONS.backup.anchorId}
						className={SECTION_HEADING}
					>
						{SETTINGS_SECTIONS.backup.title}
					</h3>
					<div className="flex gap-2">
						<button type="button" onClick={exportBackupFile} className={BUTTON}>
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
				</>
			}
		>
			<input
				ref={importInputRef}
				type="file"
				accept="application/json,.json"
				onChange={onImportFile}
				className="hidden"
			/>
			{unreadableSettings !== null ? (
				<div className="flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/5 p-3">
					<p className="text-sm text-red-300">
						Your stored settings could not be read, so the app is running on
						defaults. The original file has been left untouched and nothing will
						be written over it until you choose. Download a copy first if you
						want to keep it, then reset to start fresh.
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={downloadUnreadableSettings}
							className={BUTTON}
						>
							Download settings
						</button>
						<ConfirmButton
							label="Reset settings"
							confirmLabel="Confirm reset"
							onConfirm={resetUnreadableSettings}
						/>
					</div>
				</div>
			) : null}
			{preMigration !== null ? (
				<div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
					<p className="text-sm text-amber-300">
						Your settings were upgraded, and a copy of the values from before
						the upgrade was kept. Download it if you want a copy.
					</p>
					<button
						type="button"
						onClick={downloadPreMigration}
						className={BUTTON}
					>
						Download pre-upgrade settings
					</button>
				</div>
			) : null}
			<p className="text-xs text-neutral-500">
				Move settings and conversations between the desktop app and the website
				as a JSON file. The file contains your API keys — keep it private.
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
		</Section>
	);
}

/**
 * The updates block (`settings.sections`).
 *
 * The updater is desktop-only — the website deploys continuously and has
 * nothing to update — but the release notes are not: they describe the version
 * the app runs, on every platform, so the control that reopens them is here on
 * both.
 */
export function UpdatesSection() {
	const updates = useUpdates();

	// This view owns the Updates section: run a fresh check when
	// it mounts, so the section never shows a stale answer (the
	// strip's own check may predate it, or have been dismissed).
	useEffect(() => {
		if (!isDesktop) return;
		checkForUpdates();
	}, []);

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY}
			heading={
				<>
					<h3
						id={SETTINGS_SECTIONS.updates.anchorId}
						className={SECTION_HEADING}
					>
						{SETTINGS_SECTIONS.updates.title}
					</h3>
					{isDesktop ? (
						<button
							type="button"
							onClick={checkForUpdates}
							disabled={
								updates.phase === "checking" || updates.phase === "downloading"
							}
							className={BUTTON}
						>
							Check for updates
						</button>
					) : null}
				</>
			}
		>
			<button type="button" onClick={openReleaseNotes} className={BUTTON}>
				View release notes
			</button>
			{updates.running !== null ? (
				<p className="text-xs text-neutral-500">
					Running version {updates.running}
				</p>
			) : null}
			{updates.phase === "checking" ? (
				<p className="text-xs text-neutral-500">Checking for updates…</p>
			) : null}
			{updates.phase === "current" ? (
				<p className="text-sm text-neutral-500">
					You are on the latest version.
				</p>
			) : null}
			{(updates.phase === "available" || updates.phase === "downloading") &&
			updates.offer !== null ? (
				<div className="flex flex-col gap-3">
					<p className="text-sm text-neutral-500">
						Version {updates.offer.version} is available.
					</p>
					{updates.offer.kind === "updater" ? (
						<button
							type="button"
							onClick={installNow}
							disabled={updates.phase === "downloading"}
							className={BUTTON}
						>
							Update now
						</button>
					) : (
						<a
							href={LATEST_RELEASE_URL}
							target="_blank"
							rel="noreferrer noopener"
							className="text-xs text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
						>
							Open the release page
						</a>
					)}
					{updates.phase === "downloading" ? (
						<p className="text-xs text-neutral-500">
							{updates.percent === null
								? "Downloading… (size unknown)"
								: `Downloading… ${updates.percent}%`}
						</p>
					) : null}
				</div>
			) : null}
			{updates.phase === "failed" ? (
				<div className="flex flex-col gap-3">
					<span className="text-sm text-red-400">
						{updates.message ?? "Update check failed."}
					</span>
					<div className="flex items-center gap-3">
						<a
							href={LATEST_RELEASE_URL}
							target="_blank"
							rel="noreferrer noopener"
							className="text-xs text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
						>
							Open the release page
						</a>
						<button type="button" onClick={checkForUpdates} className={BUTTON}>
							Retry
						</button>
					</div>
				</div>
			) : null}
		</Section>
	);
}
