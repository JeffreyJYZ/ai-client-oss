import { reference } from "@/docs/reference.generated";
import { Section } from "./kit";
import { ReferenceView } from "./ReferenceView";
import {
	DataSection,
	InstallSection,
	OverviewSection,
	PluginsSection,
	ProvidersSection,
	TrustSection,
} from "./sections";

/**
 * The `/docs` page. It is a second Vite entry (`web/docs/index.html`), not a
 * route in the app: no router, no new runtime dependency, and the app's own
 * bundle is untouched. The only input it takes is the generated reference,
 * which `bun run docs` (and therefore `bun run build`) rewrites from source.
 */

const navItems = [
	{ id: "overview", label: "Overview" },
	{ id: "install", label: "Install" },
	{ id: "providers", label: "Providers" },
	{ id: "plugins", label: "Plugins" },
	{ id: "trust", label: "Trust model" },
	{ id: "reference", label: "API reference" },
	{ id: "data", label: "Data & backup" },
];

export default function Docs() {
	return (
		<div className="min-h-screen bg-[var(--docs-bg)]">
			<header className="border-b border-[color:var(--docs-border)]">
				<div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
					<a
						href="/"
						className="text-sm text-[color:var(--docs-body)] hover:text-[color:var(--docs-fg)]"
					>
						← Open Source AI Client
					</a>
					<span className="uppercase tracking-widest text-[11px] text-[color:var(--docs-faint)]">
						Docs
					</span>
				</div>
			</header>

			<nav className="flex flex-wrap gap-2 border-b border-[color:var(--docs-border)] px-6 py-4 lg:hidden">
				{navItems.map((item) => (
					<a
						key={item.id}
						href={`#${item.id}`}
						className="rounded border border-[color:var(--docs-border)] px-2 py-1 text-xs text-[color:var(--docs-muted)]"
					>
						{item.label}
					</a>
				))}
			</nav>

			<div className="mx-auto flex max-w-6xl items-start gap-12 px-6">
				<nav className="sticky top-8 hidden w-48 shrink-0 flex-col gap-0.5 py-10 lg:flex">
					<p className="mb-2 uppercase tracking-widest text-[11px] text-[color:var(--docs-faint)]">
						On this page
					</p>
					{navItems.map((item) => (
						<a
							key={item.id}
							href={`#${item.id}`}
							className="rounded px-2 py-1 text-sm text-[color:var(--docs-muted)] hover:bg-[var(--docs-panel-solid)] hover:text-[color:var(--docs-fg)]"
						>
							{item.label}
						</a>
					))}
				</nav>

				<main className="flex min-w-0 flex-1 flex-col gap-16 py-10 pb-24">
					<OverviewSection />
					<InstallSection />
					<ProvidersSection />
					<PluginsSection authorGuide={reference.authorGuide} />
					<TrustSection />
					<Section
						id="reference"
						title="Plugin API reference"
						lead="Generated from the shipped source, so it tracks the API as the API changes. Nothing below was written by hand."
					>
						<ReferenceView reference={reference} />
					</Section>
					<DataSection />
				</main>
			</div>
		</div>
	);
}
