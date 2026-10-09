# ai-client-oss

Tauri desktop app (`oss-ai-client`) with a Vite + React 19 (TS) frontend. Bun + Biome (root `biome.jsonc`).

## Layout

- `web/` — the frontend *and* its own `package.json`/`bun.lock`. Run every web command from here.
- `web/src-tauri/` — Rust shell (`tauri.conf.json`, `Cargo.toml`); Tauri `beforeDevCommand`/`beforeBuildCommand` = `bun run dev` / `bun run build`.
- `web/src/` — all frontend source.
- `android/`, `ios/` at repo root — empty placeholders, not real mobile output.

## Fonts

- **System stacks only — never bundle font files.** Sole font home is `web/src/ui/fonts.css` (`--sans/--heading/--mono/--rounded/--serif` on `:root`); the CSS entry `web/src/App.css` consumes them (`html { font-family: var(--mono) }`).
- Apple faces come from the CSS generics, not a file: `ui-sans-serif`→SF Pro, `ui-monospace`→SF Mono, `ui-rounded`→SF Pro Rounded, `ui-serif`→New York (all variable; italic via `font-style`). Non-Apple OS falls back to its native UI font.
- **No `@font-face`/`url()` font assets, and never self-host Apple SF** — the SF license forbids embedding, redistribution and derivative works. Full license + system-font detail in the global `AGENTS.md`.

## Tailwind

- Tailwind **v4** via `@tailwindcss/vite` (devDeps in `web/`). No PostCSS config; CSS entry is `web/src/App.css` (`@import "tailwindcss";` first, above `ui/fonts.css`). Theme goes in CSS via `@theme`.
- `web/tailwind.config.mjs` exists **only for editor IntelliSense** (Zed / VS Code LSP) — v4 auto-detects content and the Vite plugin ignores the file. Never `@config` it from CSS unless real theme moves there.
- `biome.jsonc` sets `css.parser.tailwindDirectives: true` so Biome parses `@theme`/`@apply`/`@utility`.

## Linting

- **Effect checking = two layers, both wired.** Biome GritQL plugins are syntactic (no types); the Effect language service is type-aware.
- **Biome GritQL:** `biome-plugins/*.grit` ban `async`/`await`/`throw`/`try-catch`/`new Promise`. Wired in `biome.jsonc` `plugins`, each scoped `"includes": ["**/web/src/**"]` — the glob **needs the leading `**/`** (`web/src/**` silently matches nothing). Suppress per line: `// biome-ignore lint/plugin/<rule>: reason` (used for `main.tsx`'s bootstrap throw).
- **Effect language service:** `@effect/language-service` in `web/tsconfig.app.json` `compilerOptions.plugins`. Headless: `bunx effect-language-service diagnostics --project tsconfig.app.json --format text` (catches `floatingEffect`, `missingEffectContext`, `missingReturnYieldStar`; exits 1 on findings). Wired into `web` `lint` — `biome check . && effect-language-service diagnostics --project tsconfig.app.json` — so `build` runs it too. For CI/`tsc`: `effect-language-service patch`. Add rules: `effect-language-service config`.
- **Gotcha:** Biome `correctness/useYield` errors on a trivial `Effect.gen(function* () { return x })` with no `yield*` — use `Effect.succeed`/`Effect.sync` for no-yield effects.
- **Gotcha:** callback-based Web APIs (`FileReader`, `IDBRequest`) with `Effect.tryPromise` need a raw `new Promise`, which `no-new-promise.grit` bans — use `Effect.callback` (see `lib/db/web.ts`, `ui/Composer.tsx`). A typed `new Promise<T>()` slips past the plugin's pattern (evades rather than fixes — don't).
