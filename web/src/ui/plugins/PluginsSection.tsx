import {
	PLUGIN_TRUST_POINTS,
	PLUGIN_TRUST_SUMMARY,
} from "@lib/plugins/consent";
import { pastedFiles } from "@lib/plugins/pasted";
import { Effect } from "effect";
import { type ChangeEvent, useRef, useState } from "react";
import {
	installFromText,
	installFromUrl,
	PLUGIN_SOURCE_MAX_CHARS,
	reloadAll,
	setPluginsEnabled,
	usePlugins,
} from "@/state/plugins";
import {
	Button,
	INPUT,
	LABEL,
	SECTION,
	SECTION_SUMMARY_WRAP,
	Section,
} from "@/ui/kit";
import { PluginLog } from "@/ui/plugins/PluginLog";
import { PluginRow } from "@/ui/plugins/PluginRow";

/**
 * The Plugins section (spec §9). One master switch — default off — gates the
 * whole subsystem, and the section states plainly what turning it on means:
 * a plugin runs in this app with the app's own access, and no part of this
 * build limits what an installed one can do. The capability list under each
 * plugin is the same honest classification the reference page renders, from
 * the one place in the tree that holds it.
 *
 * Install has three doors — pasted source, a URL, the file picker — into the
 * one install path the store owns, so validation and the size bound cannot
 * differ between them.
 */

const HEADING = "text-xs uppercase tracking-widest text-neutral-500";
const DEFAULT_ENTRY = "main.js";

/** Read one picked file as text. `FileReader` is callback-based, hence `Effect.callback`. */
const readFile = (
	file: File,
): Effect.Effect<readonly [string, string], string> =>
	Effect.callback<string, string>((resume) => {
		const reader = new FileReader();
		reader.onload = () => resume(Effect.succeed(String(reader.result ?? "")));
		reader.onerror = () => resume(Effect.fail(`could not read ${file.name}`));
		reader.readAsText(file);
	}).pipe(Effect.map((text) => [file.name, text] as const));

/** The `files` record an install takes, keyed by the file's own name. */
const readFiles = (
	files: readonly File[],
): Effect.Effect<Record<string, string>, string> =>
	Effect.forEach(files, readFile, { concurrency: 1 }).pipe(
		Effect.map((pairs) => Object.fromEntries(pairs) as Record<string, string>),
	);

export function PluginsSection() {
	const plugins = usePlugins();
	const [manifestText, setManifestText] = useState("");
	const [entryName, setEntryName] = useState(DEFAULT_ENTRY);
	const [entryText, setEntryText] = useState("");
	const [url, setUrl] = useState("");
	const [pickError, setPickError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const installPasted = (): void => {
		const files = pastedFiles(manifestText, entryName, entryText);
		if (files === null) return;
		installFromText("", files);
	};

	/**
	 * The file picker reads the chosen files here and hands the store the same
	 * `files` record the other two doors build; a read failure is this
	 * component's own line, because it never reaches the store.
	 */
	const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
		const picked =
			event.target.files === null ? [] : Array.from(event.target.files);
		// Reset so re-picking the same file fires `change` again.
		event.target.value = "";
		if (picked.length === 0) return;
		setPickError(null);
		Effect.runFork(
			readFiles(picked).pipe(
				Effect.tap((record) =>
					Effect.sync(() => {
						installFromText("", record);
					}),
				),
				Effect.catch((detail) =>
					Effect.sync(() => {
						setPickError(detail);
					}),
				),
			),
		);
	};

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY_WRAP}
			heading={
				<>
					<h3 className={HEADING}>Plugins</h3>
					<label className="flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-500">
						Enabled
						<input
							type="checkbox"
							checked={plugins.enabled}
							onChange={(event) => setPluginsEnabled(event.target.checked)}
							className="h-4 w-4 accent-neutral-300"
						/>
					</label>
				</>
			}
		>
			<div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
				<p className="text-sm text-amber-300">{PLUGIN_TRUST_SUMMARY}</p>
				<ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-amber-200/80">
					{PLUGIN_TRUST_POINTS.map((point) => (
						<li key={point}>{point}</li>
					))}
				</ul>
			</div>

			{plugins.notice === null ? null : (
				<p
					className={`whitespace-pre-wrap break-words text-sm ${
						plugins.notice.ok ? "text-green-400" : "text-red-400"
					}`}
				>
					{plugins.notice.text}
				</p>
			)}

			{plugins.enabled ? null : (
				<p className="text-xs text-neutral-500">
					Plugins are off. Turn them on to install and run one.
				</p>
			)}

			{plugins.plugins.length === 0 ? (
				<p className="text-sm text-neutral-500">Nothing installed.</p>
			) : (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Button
							onClick={reloadAll}
							disabled={!plugins.enabled}
							title="Re-read every installed plugin's files and load it again"
						>
							Reload plugins
						</Button>
						<span className="text-xs text-neutral-500">
							Re-reads each plugin&apos;s files. A reload whose new source is
							invalid keeps the running version and reports why.
						</span>
					</div>
					<ul className="flex flex-col gap-2">
						{plugins.plugins.map((plugin) => (
							<PluginRow
								key={plugin.state.id}
								plugin={plugin}
								master={plugins.enabled}
							/>
						))}
					</ul>
				</div>
			)}

			<div className="flex flex-col gap-3 border-t border-neutral-800 pt-3">
				<p className={HEADING}>Install</p>
				<label className={LABEL}>
					Manifest (plugin.json)
					<textarea
						rows={5}
						value={manifestText}
						disabled={!plugins.enabled}
						onChange={(event) => setManifestText(event.target.value)}
						placeholder='{ "id": "acme.hello", "name": "Hello", "version": "1.0.0", "apiVersion": "0.1", "entry": "main.js" }'
						className={INPUT}
					/>
				</label>
				<label className={LABEL}>
					Entry file name
					<input
						type="text"
						value={entryName}
						disabled={!plugins.enabled}
						onChange={(event) => setEntryName(event.target.value)}
						className={INPUT}
					/>
				</label>
				<label className={LABEL}>
					Entry source
					<textarea
						rows={6}
						value={entryText}
						disabled={!plugins.enabled}
						onChange={(event) => setEntryText(event.target.value)}
						placeholder={
							'export default { setup(host) { host.log.info("hi"); } }'
						}
						className={INPUT}
					/>
				</label>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={installPasted}
						disabled={
							!plugins.enabled ||
							pastedFiles(manifestText, entryName, entryText) === null
						}
					>
						Install pasted plugin
					</Button>
					<Button
						onClick={() => fileInputRef.current?.click()}
						disabled={!plugins.enabled}
					>
						Choose files…
					</Button>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept=".json,.js,.mjs,.ts"
						onChange={onPick}
						className="hidden"
					/>
				</div>
				<p className="text-xs text-neutral-500">
					Picked files are keyed by their own names and must include
					plugin.json. The entry file name above must match the manifest&apos;s
					entry, and cannot be plugin.json itself — that name is the
					manifest&apos;s.
				</p>
				{pickError === null ? null : (
					<p className="text-sm text-red-400">{pickError}</p>
				)}
				<label className={LABEL}>
					Install from URL
					<input
						type="text"
						value={url}
						disabled={!plugins.enabled}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="https://example.com/plugin-files.json"
						className={INPUT}
					/>
				</label>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={() => installFromUrl(url.trim())}
						disabled={!plugins.enabled || url.trim() === ""}
					>
						Install from URL
					</Button>
				</div>
				<p className="text-xs text-neutral-500">
					The URL must return the plugin&apos;s files as JSON, keyed by file
					name — {'{ "plugin.json": "…", "main.js": "…" }'} — and the fetch is
					bounded to {PLUGIN_SOURCE_MAX_CHARS} characters.
				</p>
			</div>

			<PluginLog />
		</Section>
	);
}
