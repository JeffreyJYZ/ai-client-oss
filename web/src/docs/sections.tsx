import { Callout, Code, Prose, Section, SubSection } from "./kit";

/**
 * The curated documentation: the pages a human reads, as opposed to the
 * generated reference. Prose only — nothing here restates an API, and the
 * capability table (the one place a claim could go wrong) is generated.
 */

export const OverviewSection = () => (
	<Section
		id="overview"
		title="What this is"
		lead="A desktop and web client for OpenAI-compatible and Anthropic endpoints, with your data stored locally. One codebase ships as a Tauri desktop app and as a website."
	>
		<Prose>
			<p>
				Point it at any OpenAI- or Anthropic-compatible endpoint — a hosted
				provider or a local model server — and chat with streaming replies,
				reasoning blocks, attachments and per-conversation system prompts.
			</p>
			<p>
				Conversations, settings and API keys stay on your machine: there is no
				account and no analytics. The desktop app updates itself from signed
				releases; the web build is the same app in a browser tab.
			</p>
		</Prose>
		<SubSection title="Highlights">
			<ul className="flex max-w-3xl flex-col gap-2 text-sm leading-6 text-[color:var(--docs-body)]">
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Any compatible endpoint
					</strong>{" "}
					— no vendor lock-in, including local models through Ollama or LM
					Studio.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Reads pages you link
					</strong>{" "}
					— the model can fetch a URL and answer from the page itself.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Web search
					</strong>{" "}
					— through the endpoint's own tool where it has one, or TinyFish with
					your own key, which is how a local model gets search at all.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Durable notes
					</strong>{" "}
					— memories the model writes as it works, plus your own.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Extensible
					</strong>{" "}
					— plugins can contribute to any UI region and drive every logic seam.
					See the plugin API reference below.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						GPL-3.0-only
					</strong>{" "}
					— open source; the 0.1.x releases were MIT and stay MIT.
				</li>
			</ul>
		</SubSection>
	</Section>
);

export const InstallSection = () => (
	<Section
		id="install"
		title="Install"
		lead="Releases publish macOS (universal), Windows and Linux builds. The web build needs nothing installed."
	>
		<SubSection title="macOS (Homebrew)">
			<Code>{`brew trust jeffreyjyz/tap
brew install --cask jeffreyjyz/tap/oss-ai-client`}</Code>
			<Prose>
				<p>
					Casks from a third-party tap are refused until you trust it once per
					machine — a cask can run code, which is why Homebrew gates it. The tap
					repins itself to the newest release, and the app updates itself from
					then on, so <span className="docs-mono">brew upgrade</span> never
					overwrites a self-updated install.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="macOS (by hand)">
			<Code>
				xattr -dr com.apple.quarantine "/Applications/oss-ai-client.app"
			</Code>
			<Callout title="Builds are unsigned and not notarized" tone="warning">
				<p>
					Gatekeeper refuses a quarantined unsigned app, and{" "}
					<strong className="font-medium">
						right-click → Open does not work
					</strong>{" "}
					on current macOS — it restricts unsigned apps further. Clearing the
					quarantine attribute, as above, is the reliable path.
				</p>
			</Callout>
		</SubSection>
		<SubSection title="Windows">
			<Prose>
				<p>
					The installer is unsigned too, so SmartScreen warns first: choose{" "}
					<strong className="font-medium text-[color:var(--docs-fg)]">
						More info
					</strong>{" "}
					then{" "}
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Run anyway
					</strong>
					.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Updates">
			<Prose>
				<p>
					The desktop app checks for a newer signed release, downloads it and
					relaunches; a Settings section can also check on demand. In-app
					updating arrived in 0.1.2 — an older install (0.1.0 or 0.1.1) has no
					updater and must be replaced by hand once.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Web build">
			<Prose>
				<p>
					The same frontend runs at{" "}
					<a
						className="text-[color:var(--docs-link)] underline underline-offset-2 hover:text-[color:var(--docs-link-hover)]"
						href="https://aiclient.jyz.land"
						target="_blank"
						rel="noreferrer"
					>
						aiclient.jyz.land
					</a>
					. It has no filesystem, so plugin source lives in the browser's
					IndexedDB instead of a directory, and data lives in browser storage
					rather than the app-data directory.
				</p>
			</Prose>
		</SubSection>
	</Section>
);

export const ProvidersSection = () => (
	<Section
		id="providers"
		title="Providers"
		lead="A provider is a base URL, a wire protocol, a key and a model. Nothing is bundled and nothing is sent anywhere but the endpoint you configure."
	>
		<SubSection title="Ready-made">
			<Prose>
				<p>
					OpenAI (Responses or Chat Completions), OpenRouter, OpenCode Zen,
					OpenCode Go, Command Code, Volcengine ARK (platform or Agent Plan),
					Anthropic, Ollama, LM Studio — or any OpenAI-compatible base URL.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Keys and models">
			<Prose>
				<p>
					Keys are stored with your settings on your machine — never in a
					plugin, never on a server of ours. "Fetch models" caches the ids the
					endpoint returns so a picker can offer them without another round
					trip.
				</p>
				<p>
					A profile bundles a provider, a model, a system prompt and a variant,
					so a configuration can be applied in one pick. Export/Import moves
					settings and conversations between the desktop and web builds.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Web search">
			<Prose>
				<p>
					Where the endpoint has its own search tool — OpenAI, OpenRouter,
					Anthropic — the model decides whether to search, and search is a tool
					the model may call zero or more times. Where it has none, TinyFish
					with your own key is how a local model gets search at all.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Tools">
			<Prose>
				<p>
					The model can fetch a URL you give it, and plugins can register their
					own model-callable tools. Registration, lookup and execution are the
					documented tool surface in the API reference below.
				</p>
			</Prose>
		</SubSection>
	</Section>
);

export const PluginsSection = ({
	authorGuide,
}: {
	authorGuide: { available: boolean; url: string };
}) => (
	<Section
		id="plugins"
		title="Plugins"
		lead="A plugin is one directory with a manifest and one pre-built ESM entry file, loaded into the app process."
	>
		<Callout title="Read the trust model first" tone="warning">
			<p>
				A plugin is full-trust code running inside the app, with the app's own
				privileges. It can read every API key, every stored conversation and the
				app's data directory, and make arbitrary network calls. There is no
				in-process sandbox — see the trust model section, and do not install a
				plugin you would not run as your own code.
			</p>
		</Callout>
		<SubSection title="The whole thing is gated">
			<Prose>
				<p>
					Plugins are off by default behind a master switch, and enabling that
					switch — and installing a plugin — shows the capabilities the manifest
					declares plus a plain warning that plugins are unsandboxed.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Anatomy">
			<Prose>
				<p>
					<span className="docs-mono">plugin.json</span> declares identity,
					version, the entry file, the capability labels it wants and the app
					version it targets. The entry is{" "}
					<strong className="font-medium text-[color:var(--docs-fg)]">
						one pre-built ESM file with no imports
					</strong>{" "}
					— a bundled desktop app has no module resolver for a plugin directory,
					so the host supplies React and the API through globals set before the
					module is imported.
				</p>
				<p>
					Every registration returns a handle, and the host attaches it to that
					plugin's scope: disabling a plugin disposes everything it registered,
					in reverse order, with no page reload.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Author guide">
			{authorGuide.available ? (
				<Prose>
					<p>
						<a
							className="text-[color:var(--docs-link)] underline underline-offset-2 hover:text-[color:var(--docs-link-hover)]"
							href={authorGuide.url}
							target="_blank"
							rel="noreferrer"
						>
							The plugin author's guide
						</a>{" "}
						walks through the manifest, the build preset and a worked example
						per registry.
					</p>
				</Prose>
			) : (
				<Prose>
					<p className="text-[color:var(--docs-muted)]">
						The plugin author's guide ({" "}
						<span className="docs-mono">{authorGuide.url}</span> ) lands with
						the plugin system and is not in the tree yet; the generated API
						reference below is current regardless.
					</p>
				</Prose>
			)}
		</SubSection>
	</Section>
);

export const TrustSection = () => (
	<Section
		id="trust"
		title="Trust model"
		lead="This is the part a marketing page would soften. It is not softened here, because a plugin author and an installer both need it to be exact."
	>
		<Callout title="Full trust, in process" tone="warning">
			<p>
				A plugin runs inside the app process with the app's own privileges. It
				can read every provider API key, the TinyFish key, every stored
				conversation, <span className="docs-mono">localStorage</span>, IndexedDB
				and the app-data directory; it can make arbitrary network calls; and it
				can call any Tauri command the window is permitted to call.
			</p>
			<p>
				It{" "}
				<strong className="font-medium">cannot be sandboxed in process</strong>,
				so every API boundary the design draws is advisory against a plugin that
				chooses to ignore it. There is no untrusted tier.
			</p>
		</Callout>
		<SubSection title="What is actually enforced">
			<ul className="flex max-w-3xl flex-col gap-2 text-sm leading-6 text-[color:var(--docs-body)]">
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Failure isolation is real.
					</strong>{" "}
					A plugin that throws, fails to load, or faults a middleware stage is
					disabled and skipped; the app must never white-screen because of a
					plugin.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Lifetime is real.
					</strong>{" "}
					Disabling a plugin disposes every registration it made, in reverse
					order.
				</li>
				<li>
					<strong className="font-medium text-[color:var(--docs-fg)]">
						Capability labels are labels.
					</strong>{" "}
					They are shown and consented to. What each one enforces — usually
					nothing — is stated per row in the capability table of the reference
					below.
				</li>
			</ul>
		</SubSection>
		<SubSection title="What is not claimed">
			<Prose>
				<p>
					No capability is a sandbox. <span className="docs-mono">net</span> is
					unenforceable because the webview has a global{" "}
					<span className="docs-mono">fetch</span>.{" "}
					<span className="docs-mono">plugin-data</span> is path-scoped in Rust
					through the API's shape, not a security boundary — a plugin can still
					call the raw command with another id. The remaining labels are
					consent-only and not built in v1.
				</p>
				<p>
					A hosted plugin registry, signing and a review policy are out of scope
					for this design; a sandboxed tier would need a worker or iframe and a
					message protocol, which does not exist yet.
				</p>
			</Prose>
		</SubSection>
	</Section>
);

export const DataSection = () => (
	<Section
		id="data"
		title="Data and backup"
		lead="Everything lives locally. Export/Import in Settings moves it between installs and between the desktop and web builds."
	>
		<SubSection title="Where it lives">
			<Prose>
				<p>
					Desktop: settings in <span className="docs-mono">settings.json</span>{" "}
					under the app's data directory (macOS:{" "}
					<span className="docs-mono">
						~/Library/Application Support/land.jyz.aiclient/
					</span>
					), conversations in the local database beside it.
				</p>
				<p>
					Web: settings in <span className="docs-mono">localStorage</span>,
					conversations in IndexedDB. A plugin's own storage rides your
					settings, so it is covered by a backup.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Backup">
			<Prose>
				<p>
					Export writes one file holding settings and conversations; Import
					replaces settings and upserts conversations — it never deletes
					anything. An import is not applied while an unreadable settings blob
					is outstanding: reset settings first, then import. That is deliberate
					— refusing beats overwriting.
				</p>
			</Prose>
		</SubSection>
		<SubSection title="Upgrading safely">
			<Prose>
				<p>
					An upgrade is additive: a settings file written by an older version
					parses unchanged, so there is no manual step. If a stored blob cannot
					be parsed at all, the app keeps it, runs on in-memory defaults, offers
					you the raw value, and refuses to write over it until you explicitly
					reset — a parse failure is never a silent wipe.
				</p>
			</Prose>
		</SubSection>
		<Callout title="Downgrading" tone="warning">
			<p>
				Downgrading is not compatible and cannot be made so: an older build
				reading settings that name a plugin protocol can fail to parse the whole
				object, and it has neither the safety net nor the per-field tolerance.
				Export a backup before you downgrade.
			</p>
		</Callout>
	</Section>
);
