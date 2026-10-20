import type { ExamplesIndex, PluginExample } from "@lib/build/examplesIndex";
import {
	PLUGIN_TRUST_POINTS,
	PLUGIN_TRUST_SUMMARY,
} from "@lib/plugins/consent";
import { pastedFiles } from "@lib/plugins/pasted";
import { Effect } from "effect";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { SETTINGS_SECTIONS } from "@/lib/settingsSections";
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
	SECTION_HEADING,
	SECTION_SUMMARY_WRAP,
	Section,
	SUBHEADING,
	SubSection,
} from "@/ui/kit";
import { BuiltinsArea } from "@/ui/plugins/BuiltinsArea";
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
 *
 * The section also carries the **Built-ins** area (`BuiltinsArea.tsx`): the
 * per-area and per-contribution toggles for the app's own areas. Those are
 * independent of the master switch above — the switch gates installed plugins,
 * while the built-ins are part of the app and default on — which the area states
 * plainly so the two are not read as one.
 */

const HEADING = SECTION_HEADING;
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

/**
 * The index a release ships, filtered to well-formed rows. It is a static file
 * beside the chunks, so a malformed one must degrade to "no examples" rather
 * than render a broken Install button.
 */
const examplesOf = (json: unknown): readonly PluginExample[] => {
	const index = json as ExamplesIndex | undefined;
	if (!Array.isArray(index?.examples)) return [];
	return index.examples.filter(
		(example): example is PluginExample =>
			typeof example?.id === "string" &&
			typeof example.name === "string" &&
			typeof example.description === "string" &&
			typeof example.entry === "string" &&
			typeof example.manifest === "string",
	);
};

export function PluginsSection() {
	const plugins = usePlugins();
	const [manifestText, setManifestText] = useState("");
	const [entryName, setEntryName] = useState(DEFAULT_ENTRY);
	const [entryText, setEntryText] = useState("");
	const [url, setUrl] = useState("");
	const [pickError, setPickError] = useState<string | null>(null);
	const [examples, setExamples] = useState<readonly PluginExample[]>([]);
	const [exampleError, setExampleError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	/**
	 * The examples a release ships. The index is written by
	 * `scripts/build-plugins.ts` beside the chunks, so it is absent in a build
	 * that skipped them — an empty list is the honest answer there, never a
	 * hardcoded one.
	 */
	useEffect(() => {
		let live = true;
		void fetch("/plugins/examples.json")
			.then((response) => (response.ok ? response.json() : undefined))
			.then((json: unknown) => {
				if (!live) return;
				setExamples(examplesOf(json));
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);

	/** Install one shipped example: its manifest plus the chunk fetched now. */
	const installExample = (example: PluginExample): void => {
		setExampleError(null);
		Effect.runFork(
			Effect.tryPromise({
				try: () =>
					fetch(example.entry).then((response) =>
						response.ok ? response.text() : "",
					),
				catch: () => `could not read ${example.entry}`,
			}).pipe(
				Effect.flatMap((source) =>
					source === ""
						? Effect.fail(`could not read ${example.entry}`)
						: Effect.succeed(source),
				),
				Effect.tap((source) =>
					Effect.sync(() => {
						installFromText("", {
							"plugin.json": example.manifest,
							"main.js": source,
						});
					}),
				),
				Effect.catch((detail) =>
					Effect.sync(() => {
						setExampleError(detail);
					}),
				),
			),
		);
	};

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
					<h3 id={SETTINGS_SECTIONS.plugins.id} className={HEADING}>
						{SETTINGS_SECTIONS.plugins.title}
					</h3>
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

			<BuiltinsArea />

			<SubSection
				heading={
					<p className={SUBHEADING}>
						Installed{" "}
						<span className="font-mono text-[0.65rem] tracking-normal text-neutral-600">
							{plugins.plugins.length}
						</span>
					</p>
				}
			>
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
			</SubSection>

			<SubSection heading={<p className={SUBHEADING}>Install</p>}>
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
			</SubSection>

			<SubSection heading={<p className={SUBHEADING}>Examples</p>}>
				<p className="text-xs text-neutral-500">
					Shipped with this build. Installing one copies its manifest and code
					into your plugins — it is full-trust code like any other, so the
					switch above must be on.
				</p>
				{examples.length === 0 ? (
					<p className="text-xs text-neutral-500">
						This build ships no examples.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{examples.map((example) => (
							<li
								key={example.id}
								className="flex items-start justify-between gap-3"
							>
								<div>
									<p className="text-sm text-neutral-200">{example.name}</p>
									<p className="text-xs text-neutral-500">
										{example.description}
									</p>
								</div>
								<Button
									onClick={() => installExample(example)}
									disabled={!plugins.enabled}
								>
									Install
								</Button>
							</li>
						))}
					</ul>
				)}
				{exampleError === null ? null : (
					<p className="text-sm text-red-400">{exampleError}</p>
				)}
			</SubSection>

			<PluginLog />
		</Section>
	);
}
