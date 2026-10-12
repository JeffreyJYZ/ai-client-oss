import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite does not read tsconfig `paths`, so mirror them here or every `@lib/*` /
// `@/*` import 500s in dev. Resolved relative to this config file.
const fromConfig = (path: string): string =>
	fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
	resolve: {
		alias: {
			"@lib": fromConfig("./src/lib"),
			"@ui": fromConfig("./src/ui"),
			"@root": fromConfig("."),
			"@": fromConfig("./src"),
		},
	},
	plugins: [
		react(),
		tailwindcss(),
		babel({ presets: [reactCompilerPreset()] }),
	],
	build: {
		// Two entries: the app at `/` and the documentation site at `/docs/`.
		// A second HTML input is what makes `/docs/` exist on Vercel without a
		// router or a rewrite (the app is a single page and has no router).
		rollupOptions: {
			input: {
				app: fromConfig("./index.html"),
				docs: fromConfig("./docs/index.html"),
			},
		},
	},
});
