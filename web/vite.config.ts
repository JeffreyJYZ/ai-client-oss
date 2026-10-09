import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
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
	plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
});
