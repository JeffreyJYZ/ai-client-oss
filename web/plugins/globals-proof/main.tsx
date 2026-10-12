/**
 * Task 17's browser-proof fixture (spec §6). It uses **JSX and `useState`**, so
 * the preset must turn its `react` and `react/jsx-runtime` imports into the
 * host globals and emit an import-free bundle; and it reads
 * `globalThis.__aiClient` while its module body evaluates, before `setup` runs,
 * so a browser load proves the globals were set *before* the import.
 */
import { useState } from "react";

const api = (globalThis as { __aiClient?: { version: { api: string } } })
	.__aiClient;

function Counter(): unknown {
	const [count, setCount] = useState(0);
	return (
		<button type="button" onClick={() => setCount(count + 1)}>
			count {count}
		</button>
	);
}

const element = <span>sdk</span>;

export default {
	/** Read at module evaluation — non-null only if the globals preceded the import. */
	apiAtImport: api?.version.api ?? null,
	/** JSX ran against the host's jsx runtime: a real React element, made above. */
	elementType: element.type,
	elementChildren: (element as { props?: { children?: unknown } }).props
		?.children,
	isReactElement: String((element as { $$typeof?: unknown }).$$typeof).includes(
		"react.",
	),
	/** `useState` resolved to the app's own React instance, not a second copy. */
	useStateMatchesHost:
		useState ===
		(globalThis as { __aiClientReact?: { useState?: unknown } }).__aiClientReact
			?.useState,
	counterIsFunction: typeof Counter === "function",
	setup(host: unknown): void {
		(globalThis as Record<string, unknown>).__fixtureSetupHost = host;
	},
};
