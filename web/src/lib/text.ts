/**
 * The one home of the character cap on text handed to the
 * model: a long page still fits whole, while one enormous
 * page cannot eat the conversation's context. `fetch.ts`
 * and `tinyfish.ts` both cap here — the pair once grew
 * duplicate helpers around a shared constant, which is how
 * the bound drifted.
 */
export const MAX_CHARS: number = 50_000;

/**
 * Apply the character cap, appending `note` (leading newline
 * included) so the model can tell it saw a slice. Each caller
 * words its own note — a page read and a search listing
 * announce themselves differently. Pure.
 */
export const capText = (text: string, note: string): string =>
	text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS) + note;

/**
 * One display-only marker line, positioned by its offset
 * in the answer text it interleaves with.
 */
export interface DisplayMarker {
	readonly at: number;
	readonly line: string;
}

/**
 * A text run with a display-only marker line appended:
 * trailing blank lines are trimmed first so two adjacent
 * markers never stack, and the marker is separated from
 * any text before it.
 */
const withMarker = (text: string, marker: string): string => {
	const base = text.replace(/\n+$/, "");
	const sep = base === "" ? "" : "\n\n";
	return `${base}${sep}${marker}\n\n`;
};

/**
 * Interleave a message's display-only markers with its
 * text runs, at the answer offsets they were recorded
 * at: each run is sliced out of `text` at the next
 * marker's boundary, so a marker always sits between
 * the runs around it. The whole visible transcript of a
 * stored assistant message — pure, so the same stored
 * message always renders the same.
 */
export const interleaveMarkers = (
	text: string,
	markers: readonly DisplayMarker[],
): string => {
	let rendered = "";
	let from = 0;
	for (const marker of markers) {
		rendered = withMarker(
			`${rendered}${text.slice(from, marker.at)}`,
			marker.line,
		);
		from = marker.at;
	}
	return `${rendered}${text.slice(from)}`;
};
