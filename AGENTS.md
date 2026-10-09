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
- **`@biomejs/biome` is a `web` devDependency, pinned exactly to the `biome.jsonc` `$schema` version** — the `lint`/`fix` scripts call bare `biome`, which resolves only if it is installed. Locally a global `~/.bun/bin/biome` hides the omission; the release workflow's `beforeBuildCommand` (`bun run build`) then dies `biome: command not found` (exit 127). Pinned (not `^`) because a formatter bump can reformat the whole tree.
- **Effect language service:** `@effect/language-service` in `web/tsconfig.app.json` `compilerOptions.plugins`. Headless: `bunx effect-language-service diagnostics --project tsconfig.app.json --format text` (catches `floatingEffect`, `missingEffectContext`, `missingReturnYieldStar`; exits 1 on findings). Wired into `web` `lint` — `biome check . && effect-language-service diagnostics --project tsconfig.app.json` — so `build` runs it too. For CI/`tsc`: `effect-language-service patch`. Add rules: `effect-language-service config`.
- **Gotcha:** Biome `correctness/useYield` errors on a trivial `Effect.gen(function* () { return x })` with no `yield*` — use `Effect.succeed`/`Effect.sync` for no-yield effects.
- **Gotcha:** callback-based Web APIs (`FileReader`, `IDBRequest`) with `Effect.tryPromise` need a raw `new Promise`, which `no-new-promise.grit` bans — use `Effect.callback` (see `lib/db/web.ts`, `ui/Composer.tsx`). A typed `new Promise<T>()` slips past the plugin's pattern (evades rather than fixes — don't).

## Release & CI

- **Version home = `web/src-tauri/tauri.conf.json` `version`** (Tauri reads it for the bundle name/version). `bun scripts/bump-version.ts <patch|minor|major|X.Y.Z>` rewrites it plus `web/src-tauri/Cargo.toml`, `web/src-tauri/Cargo.lock` (`[[package]] name = "app"`) and `web/package.json`, by targeted text replacement (never re-serialize — the JSON files are tab-indented). Runs from the repo root; `--root <dir>` overrides for tests.
- **LF only** — `.gitattributes` pins `* text=auto eol=lf`. GitHub's Windows runner checks out CRLF (`core.autocrlf=true`), which made Biome diff every line and failed `bun run lint` in the release build (only the Windows job sees it).
- **Release = `.github/workflows/release-tauri.yml`.** `workflow_dispatch` (input `bump` = patch|minor|major) runs a `version` job that bumps, commits, pushes `main`, and tags `desktop-v<version>`, then builds; a `desktop-v*` **tag push** builds only (never re-point a tag once its release is published — asset names and the release derive from it; the build job fails if the tag ≠ `tauri.conf.json`). Matrix: `macos-latest` (universal, `--target universal-apple-darwin`), `ubuntu-22.04`, `windows-latest` → `tauri-apps/tauri-action@v0` creates the GitHub Release and uploads installers. Builds are **unsigned** (no Apple/Windows certs) — macOS needs right-click → Open.
- **`ubuntu-*` Tauri jobs need the apt list:** `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (it is `libayatana-…`, **not** `libappindicator3-dev`).
- **CI = `.github/workflows/ci.yml`** (push to `main` + PRs): a `web` job (tsc, biome, effect-LS, vite build — each its own step, so a non-zero exit fails the job) and a `rust` job (`cargo check --all-targets` with the apt list).
- `web/package.json` `lint` = `biome check . && effect-language-service …` — **`&&`, never `;`** (a `;` swallows Biome's exit code, so the gate stops gating). CI runs the four web steps explicitly rather than `bun run lint`.
- App identifier is `land.jyz.aiclient`, **not** the Tauri default `com.tauri.dev` — it owns the app-data dir, so changing it orphans stored conversations.
- Website (non-Tauri) build shows a desktop download link: `web/src/constants/links.ts` + `isDesktop` from `web/src/lib/platform.ts` (the same `__TAURI_INTERNALS__` probe `lib/db/index.ts` uses).
- Validate a workflow locally with `actionlint .github/workflows/*.yml` (brew).
- **Local macOS `bunx tauri build` dies at the DMG step** (`error running bundle_dmg.sh`) — Tauri's `bundle_dmg.sh` runs a Finder AppleScript to prettify the window, which hangs without a GUI/Automation session. Prefix `CI=true` (Tauri then passes `--skip-jenkins`, skipping it), or build `--bundles app` to skip DMGs entirely. GitHub runners export `CI=true` already, and the release workflow pins it on the tauri-action step.
