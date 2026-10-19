import type { Host } from "@lib/plugins/sdk";
import type { ComponentType } from "react";

/**
 * markdown-callouts — overriding one component id.
 *
 * What it teaches: `host.renderers.register("markdown", …)` replaces the
 * component behind `ui.markdown`. The app resolves that id with `useComponent`
 * (`ui/Message.tsx`: `const Body = useComponent("ui.markdown")`) and renders it
 * as `<Body text={…} />`, so **the props contract is `{ text: string }`** —
 * a renderer is a React component of that shape, typed here as
 * `ComponentType<Record<string, unknown>>` because a component id is generic.
 *
 * What it deliberately does not do: parse markdown. A document with no callout
 * — the overwhelming majority — is handed whole to `host.ui.kit.Markdown`, the
 * app's own renderer, so this override cannot regress normal rendering. When a
 * callout *is* present the text is split into blocks: the prose around it still
 * goes through the built-in renderer, document by document, and only the
 * callout block is redrawn as a styled box.
 *
 * A callout is the GitHub blockquote form: a line starting `> [!note]`, then
 * further `>` lines. Anything else is left exactly as it was.
 */

/** `> [!note] Title` — the four tones GitHub teaches, case-insensitive. */
const CALLOUT_HEADER = /^>\s*\[!(note|tip|warning|danger)\]\s?(.*)$/i;

/** One `>` continuation line inside a callout. */
const QUOTE_LINE = /^>\s?(.*)$/;

type Tone = "note" | "tip" | "warning" | "danger";

export type Segment =
	| { readonly kind: "text"; readonly text: string; readonly offset: number }
	| {
			readonly kind: "callout";
			readonly tone: Tone;
			readonly body: string;
			readonly offset: number;
	  };

const toneOf = (raw: string | undefined): Tone => {
	const name = (raw ?? "note").toLowerCase();
	return name === "tip" || name === "warning" || name === "danger"
		? name
		: "note";
};

/**
 * Split a document into prose blocks and callouts. Pure, so the shape above is
 * the only thing a reader has to reason about: every byte of the input lands in
 * exactly one segment.
 */
export const parseCallouts = (text: string): Segment[] => {
	const lines = text.split("\n");
	const segments: Segment[] = [];
	let prose: string[] = [];
	let proseStart = 0;

	const flushProse = (): void => {
		const block = prose.join("\n");
		if (block.trim() !== "") {
			segments.push({ kind: "text", text: block, offset: proseStart });
		}
		prose = [];
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const header = CALLOUT_HEADER.exec(line);
		if (header === null) {
			if (prose.length === 0) proseStart = index;
			prose.push(line);
			index += 1;
			continue;
		}

		flushProse();
		const offset = index;
		const body: string[] = [];
		const title = header[2] ?? "";
		if (title.trim() !== "") body.push(title);
		index += 1;
		while (index < lines.length) {
			const quoted = QUOTE_LINE.exec(lines[index] ?? "");
			if (quoted === null) break;
			body.push(quoted[1] ?? "");
			index += 1;
		}
		segments.push({
			kind: "callout",
			tone: toneOf(header[1]),
			body: body.join("\n").trim(),
			offset,
		});
	}

	flushProse();
	return segments;
};

/** The tint per tone; the app's dark palette, not a new one. */
const TONES: Record<Tone, string> = {
	note: "border-sky-700/60 bg-sky-950/40",
	tip: "border-emerald-700/60 bg-emerald-950/40",
	warning: "border-amber-700/60 bg-amber-950/40",
	danger: "border-red-700/60 bg-red-950/40",
};

/** The renderer: `{ text }` in, kit `Markdown` for everything but callouts. */
const makeCalloutRenderer =
	(host: Host): ComponentType<Record<string, unknown>> =>
	({ text }) => {
		const source = typeof text === "string" ? text : "";
		const { Markdown } = host.ui.kit;
		const segments = parseCallouts(source);

		// The fast path is also the guarantee: an untouched document renders
		// through exactly the component the app would have used without us.
		if (segments.every((segment) => segment.kind === "text")) {
			return <Markdown text={source} />;
		}

		return (
			<div className="flex flex-col gap-2">
				{segments.map((segment) =>
					segment.kind === "text" ? (
						<Markdown key={`text-${segment.offset}`} text={segment.text} />
					) : (
						<aside
							key={`callout-${segment.offset}`}
							className={`rounded border px-3 py-2 ${TONES[segment.tone]}`}
						>
							<p className="mb-1 text-[10px] uppercase tracking-widest text-neutral-400">
								{segment.tone}
							</p>
							<Markdown text={segment.body} />
						</aside>
					),
				)}
			</div>
		);
	};

export default {
	/** The override is a contribution, so disposing the handle restores the built-in. */
	setup(host: Host) {
		return host.renderers.register("markdown", makeCalloutRenderer(host));
	},
};
