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
