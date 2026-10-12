import type { ReactNode } from "react";

/**
 * The small presentational kit the docs page is built from. It is deliberately
 * tiny and local — the page is a static document, not part of the app's plugin
 * kit — and dark-first, because there is no light theme to fall back to.
 */

export const Section = ({
	id,
	title,
	lead,
	children,
}: {
	id: string;
	title: string;
	/** One-paragraph summary, rendered under the heading. */
	lead?: string;
	children: ReactNode;
}) => (
	<section id={id} className="scroll-mt-24">
		<h2 className="text-xl font-medium text-[color:var(--docs-fg)]">{title}</h2>
		{lead !== undefined ? (
			<p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--docs-muted)]">
				{lead}
			</p>
		) : null}
		<div className="mt-5 flex flex-col gap-5">{children}</div>
	</section>
);

export const SubSection = ({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) => (
	<div>
		<h3 className="uppercase tracking-widest text-[11px] text-[color:var(--docs-faint)]">
			{title}
		</h3>
		<div className="mt-3 flex flex-col gap-4">{children}</div>
	</div>
);

export const Prose = ({ children }: { children: ReactNode }) => (
	<div className="flex max-w-3xl flex-col gap-3 text-sm leading-6 text-[color:var(--docs-body)]">
		{children}
	</div>
);

/**
 * A callout for things a reader must not soften: the trust warning, the
 * unsigned-build install step. `tone` picks the border and heading colour only.
 */
export const Callout = ({
	title,
	tone = "neutral",
	children,
}: {
	title: string;
	tone?: "neutral" | "warning";
	children: ReactNode;
}) => (
	<div
		className={
			tone === "warning"
				? "rounded-lg border border-[color:var(--docs-warn-border)] bg-[var(--docs-warn-bg)] p-4"
				: "rounded-lg border border-[color:var(--docs-border)] bg-[var(--docs-panel-soft)] p-4"
		}
	>
		<p
			className={
				tone === "warning"
					? "uppercase tracking-widest text-[11px] text-[color:var(--docs-warn-fg)]"
					: "uppercase tracking-widest text-[11px] text-[color:var(--docs-faint)]"
			}
		>
			{title}
		</p>
		<div className="mt-3 flex flex-col gap-3 text-sm leading-6 text-[color:var(--docs-body)]">
			{children}
		</div>
	</div>
);

export const Code = ({ children }: { children: ReactNode }) => (
	<pre className="overflow-x-auto rounded-lg border border-[color:var(--docs-border)] bg-[var(--docs-panel)] p-3 text-[12.5px] leading-5 text-[color:var(--docs-code-fg)]">
		<code>{children}</code>
	</pre>
);

export const Chip = ({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: "neutral" | "amber" | "rose";
}) => (
	<span
		className={`rounded border px-1.5 py-0.5 text-[11px] ${
			tone === "amber"
				? "border-[color:var(--docs-amber-border)] bg-[var(--docs-amber-bg)] text-[color:var(--docs-amber-fg)]"
				: tone === "rose"
					? "border-[color:var(--docs-rose-border)] bg-[var(--docs-rose-bg)] text-[color:var(--docs-rose-fg)]"
					: "border-[color:var(--docs-border-strong)] bg-[var(--docs-panel-solid)] text-[color:var(--docs-muted)]"
		}`}
	>
		{children}
	</span>
);

export const Table = ({
	head,
	rows,
}: {
	head: readonly string[];
	rows: readonly {
		readonly key: string;
		readonly cells: readonly ReactNode[];
	}[];
}) => (
	<div className="overflow-x-auto">
		<table className="w-full border-collapse text-left text-sm">
			<thead>
				<tr>
					{head.map((cell) => (
						<th
							key={cell}
							className="border-b border-[color:var(--docs-border)] pb-2 pr-4 uppercase tracking-widest text-[11px] font-normal text-[color:var(--docs-faint)]"
						>
							{cell}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.key}>
						{head.map((label, column) => (
							<td
								key={label}
								className="border-b border-[color:var(--docs-border-soft)] py-2.5 pr-4 align-top leading-5 text-[color:var(--docs-body)]"
							>
								{row.cells[column]}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	</div>
);
