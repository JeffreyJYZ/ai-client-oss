import type { ThemeDefinition } from "@lib/plugins/themes";

/**
 * The app's shipping theme (spec §4/§12): the dark palette the app already
 * uses, registered as a contribution so the theme seam is exercised by the app
 * rather than only by a fixture.
 *
 * Every value is also the `:root` default in `App.css`, so applying this theme
 * changes nothing visually — that is the point, and the browser proof checks it
 * (capture the page's computed colours, apply, compare).
 *
 * It carries no `css` block on purpose: any rule here would be a visual change,
 * and the injected-stylesheet half of the seam is exercised by the tests'
 * fixture themes and by `App.css`'s own consumption of these variables.
 *
 * **Honest limit (spec §4).** The app's colours are Tailwind utility classes,
 * so a theme restyles what a variable or a rule reaches and a full
 * semantic-token refactor is deliberately out of scope. See `themes.ts`.
 */
export const darkTheme: ThemeDefinition = {
	id: "app.theme.dark",
	name: "Dark",
	variables: {
		"--app-bg": "#0a0a0a",
		"--app-fg": "whitesmoke",
		"--app-heading": "#f5f5f5",
		"--app-link": "#60a5fa",
		"--app-link-hover": "#93c5fd",
		"--app-code-bg": "rgba(255, 255, 255, 0.08)",
	},
};
