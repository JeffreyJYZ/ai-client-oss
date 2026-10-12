import { Callout, Chip, Code, SubSection, Table } from "./kit";
import type { DocCapability, DocReference, DocSymbol } from "./types";

/**
 * The generated reference, rendered. Every heading, name, signature, member and
 * table row here comes from `reference` — the artifact `scripts/build-docs.ts`
 * extracts from the shipped source — so the page is output, not prose. The one
 * thing this file owns is the layout.
 */

const boundaryTone = (
	boundary: DocCapability["boundary"],
): "amber" | "rose" | "neutral" =>
	boundary === "path-scoped"
		? "amber"
		: boundary === "unenforceable"
			? "rose"
			: "neutral";

const SymbolRow = ({ symbol }: { symbol: DocSymbol }) => (
	<div className="border-l-2 border-[color:var(--docs-border)] pl-4">
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h4 className="docs-mono text-sm text-[color:var(--docs-fg)]">
				{symbol.name}
			</h4>
			<span className="uppercase tracking-widest text-[11px] text-[color:var(--docs-faint)]">
				{symbol.kind}
			</span>
		</div>
		{symbol.description !== "" ? (
			<p className="mt-1.5 max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
				{symbol.description}
			</p>
		) : null}
		<div className="mt-2">
			<Code>{symbol.signature}</Code>
		</div>
		{symbol.members.length > 0 ? (
			<div className="mt-2 flex flex-wrap gap-1.5">
				{symbol.members.map((member) => (
					<Chip key={member}>{member}</Chip>
				))}
			</div>
		) : null}
	</div>
);

export const ReferenceView = ({ reference }: { reference: DocReference }) => {
	const documented = reference.modules.filter(
		(module) => module.status === "documented",
	);
	const pending = reference.modules.filter(
		(module) => module.status === "pending",
	);
	return (
		<>
			<SubSection title="API surface">
				<p className="max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
					Extracted from the shipped source by{" "}
					<span className="docs-mono">scripts/build-docs.ts</span>, so it cannot
					describe an API the app does not have. Plugin API{" "}
					<span className="docs-mono">{reference.apiVersion}</span>, app{" "}
					<span className="docs-mono">{reference.appVersion}</span>.
				</p>
				{documented.map((module) => (
					<div key={module.path}>
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<h4 className="text-sm font-medium text-[color:var(--docs-fg)]">
								{module.label}
							</h4>
							<span className="docs-mono text-[11px] text-[color:var(--docs-faint)]">
								{module.path}
							</span>
						</div>
						<p className="mt-1 max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
							{module.summary}
						</p>
						<div className="mt-4 flex flex-col gap-5">
							{module.symbols.map((symbol) => (
								<SymbolRow key={symbol.name} symbol={symbol} />
							))}
						</div>
					</div>
				))}
			</SubSection>

			{pending.length > 0 ? (
				<Callout title="Not documented yet">
					<p>
						These modules are part of the plugin API but have no source in this
						build yet, so the reference names them rather than dropping them:
					</p>
					<ul className="flex flex-col gap-1">
						{pending.map((module) => (
							<li key={module.path} className="docs-mono text-[12.5px]">
								{module.path} — {module.label}
							</li>
						))}
					</ul>
				</Callout>
			) : null}

			<SubSection title="Slot map">
				<p className="max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
					Every region a contribution can render into, read from{" "}
					<span className="docs-mono">slotIds</span>. An id that is not here is
					refused at registration as a logged fault, not a crash.
				</p>
				<Table
					head={["Slot", "Region"]}
					rows={reference.slots.map((slot) => ({
						key: slot.id,
						cells: [
							<span key="id" className="docs-mono text-[12.5px]">
								{slot.id}
							</span>,
							slot.description,
						],
					}))}
				/>
			</SubSection>

			<SubSection title="Manifest fields">
				<p className="max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
					Read from <span className="docs-mono">manifestSchema</span> — the
					published shape, not a copy of it. A field with a default may be
					omitted.
				</p>
				<Table
					head={["Field", "Declared as", "Required", "Notes"]}
					rows={reference.manifestFields.map((field) => ({
						key: field.name,
						cells: [
							<span key="name" className="docs-mono text-[12.5px]">
								{field.name}
							</span>,
							<span
								key="schema"
								className="docs-mono text-[12.5px] text-[color:var(--docs-muted)]"
							>
								{field.schema}
							</span>,
							field.required ? "yes" : "no",
							field.description,
						],
					}))}
				/>
			</SubSection>

			<SubSection title="Capabilities">
				<p className="max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
					Declared permission labels. They are honest labels for consent and
					display — what is enforced is stated per row, and nothing here is a
					sandbox.
				</p>
				<Table
					head={["Capability", "Unlocks", "What is actually enforced", "Kind"]}
					rows={reference.capabilities.map((capability) => ({
						key: capability.id,
						cells: [
							<span key="id" className="docs-mono text-[12.5px]">
								{capability.id}
							</span>,
							capability.unlocks,
							capability.enforced,
							<Chip key="kind" tone={boundaryTone(capability.boundary)}>
								{capability.boundary}
							</Chip>,
						],
					}))}
				/>
			</SubSection>

			<SubSection title="Host events">
				<p className="max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
					Accepted by <span className="docs-mono">host.on(event, handler)</span>
					.
				</p>
				<Table
					head={["Event", "Fires"]}
					rows={reference.events.map((event) => ({
						key: event.name,
						cells: [
							<span key="name" className="docs-mono text-[12.5px]">
								{event.name}
							</span>,
							event.description,
						],
					}))}
				/>
			</SubSection>
		</>
	);
};
