# AI Client — Design (v1)

Status: approved in chat, proceeding to plan
Date: 2026-10-09

## Intent

Build the desktop AI client: a chat UI on top of the provider registry, with attachments and tools. **Webview-only for v1** — the Tauri shell wraps the built web app and owns no state. The registry (`SendMsg(protocol, ctx) → Effect<Stream<Chunk, string>, string>`) is the engine; this spec builds the surface on it.

## Constraints

- No new dependencies (Effect, zod, React, Tailwind already present); `src-tauri` stays stock.
- Dark-mode first.
- Effect for all async; zod for validation; `biome` + `@effect/language-service` gates stay green.
- **No test files for v1** (user's call). Verification = `tsc` + `biome` + effect-LS per task, plus a browser smoke check via `agent-browser`.
- State is webview-only: settings in `localStorage`, the conversation in memory.

## Architecture

- **State**: one store exposed through `useSyncExternalStore` (no new dep), split into two slices — `settings` (persisted to `localStorage`) and `chat` (in-memory conversation + streaming status).
- **Effect → React bridge**: `SendMsg(protocol, ctx)` is run with `Stream.runForEach` in a **forked fiber**; each `Chunk` appends to the chat store. **Stop** is `Fiber.interrupt`. No promise chains.
- **Layering**:
  - `web/src/state/settings.ts` — settings model (zod), `localStorage` persistence, subscribe/get.
  - `web/src/state/chat.ts` — conversation model, `send()` (runs the Effect), `stop()`.
  - `web/src/ui/App.tsx`, `ChatPane.tsx`, `Message.tsx`, `Composer.tsx`, `Settings.tsx` — presentational, driven by the stores.
- **Attachments** extend the registry: `SendCtx` gains `parts` (attached files/images, as data URLs + metadata); each provider's `buildRequest` maps `parts` to its wire shape — `responses` → `input_image`/`input_file` content parts; `chatcompletions` → `messages[].content` parts.
- **Tools**: the send context carries `tools` (`{ type, max_num_results }[]`, the shape `ResponsesSend` already schemas); `buildRequest` merges them into the request body.

## Components

- **App** — layout shell: transcript + composer, a settings drawer, a header with provider + model.
- **ChatPane** — scrollable transcript of `Message`s; auto-scroll while streaming.
- **Message** — renders one turn: role, text, and attachment chips.
- **Composer** — text input, attach control (file/image), send/stop button; Enter sends.
- **Settings** — provider (`responses`/`chatcompletions`), base URL, API key, model, tools toggles; writes to the settings store.

## Data flow

1. User edits settings → settings store → `localStorage`.
2. User types + attaches → `Composer` builds a `SendCtx` (msg text, `parts`, `tools`, `prev` = current conversation, `apiUrl`/`apiKey` from settings).
3. `send()` runs `SendMsg(protocol, ctx)` → `Stream.runForEach` appends `Chunk.text` to the in-progress assistant message in the chat store.
4. Stream ends → message finalized; error → error message appended.

## Error handling and cancellation

- A failed `send` (HTTP non-2xx, stream error) appends an error turn; the composer re-enables.
- **Stop** interrupts the fiber; the partial assistant message is kept.
- Settings validation via zod; invalid settings surface inline, not crash.

## Out of scope (v1)

- Multi-conversation history / sidebar, persistence of conversations, Tauri-owned secrets, tool *execution* (declaring tools only), non-OpenAI-shaped SSE, auth beyond a bearer key.
