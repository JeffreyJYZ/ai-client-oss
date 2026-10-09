# ai-client-oss

Tauri desktop app (`oss-ai-client`) with a Vite + React 19 (TS) frontend. Bun + Biome (root `biome.json`).

## Layout

- `web/` — the frontend *and* its own `package.json`/`bun.lock`. Run every web command from here.
- `web/src-tauri/` — Rust shell (`tauri.conf.json`, `Cargo.toml`); Tauri `beforeDevCommand`/`beforeBuildCommand` = `bun run dev` / `bun run build`.
- `web/src/` — all frontend source.
- `android/`, `ios/` at repo root — empty placeholders, not real mobile output.

## Fonts

- **System stacks only — never bundle font files.** Sole font home is `web/src/ui/fonts.css` (`--sans/--heading/--mono/--rounded/--serif` on `:root`); `web/src/index.css` consumes them (`font: 18px/145% var(--sans)`).
- Apple faces come from the CSS generics, not a file: `ui-sans-serif`→SF Pro, `ui-monospace`→SF Mono, `ui-rounded`→SF Pro Rounded, `ui-serif`→New York (all variable; italic via `font-style`). Non-Apple OS falls back to its native UI font.
- **No `@font-face`/`url()` font assets, and never self-host Apple SF** — the SF license forbids embedding, redistribution and derivative works. Full license + system-font detail in the global `AGENTS.md`.
