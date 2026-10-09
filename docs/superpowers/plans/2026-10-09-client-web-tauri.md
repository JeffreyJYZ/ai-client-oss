# AI Client (web + Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the desktop AI client — a dark-first chat UI over the provider registry, with attachments and tools, wrapped by the existing Tauri shell (webview-only state).

**Architecture:** A tiny `useSyncExternalStore` store (settings persisted to `localStorage`, chat in memory). The registry's `SendMsg` runs via `Stream.runForEach` in a forked fiber, appending chunks to the chat store; Stop interrupts the fiber. `SendCtx` gains `parts` (attachments) and `tools`, mapped per provider in `buildRequest`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Effect 4, zod 4, Tauri 2, Biome + `@effect/language-service`.

**Spec:** `docs/superpowers/specs/2026-10-09-client-web-tauri-design.md`

## Global Constraints

- No new dependencies; `web/src-tauri` stays stock.
- Dark-mode first; Tailwind utilities only.
- Effect for all async; zod for validation.
- **No test files** (user's call). Per-task verification = `bunx tsc -b --force` (exit 0) → `biome check .` (clean) → `bunx effect-language-service diagnostics --project tsconfig.app.json` (0 errors); UI tasks add a browser smoke via `agent-browser`.
- Source under `web/src/`; components under `web/src/ui/`, state under `web/src/state/`.

## Review Focus

Failure modes the happy path won't exercise — each gets an explicit check in the owning task:

1. **Empty/whitespace message** with no attachments → send must be disabled, not a malformed request.
2. **No API key set** → send disabled (or an inline settings prompt), never a request with `authorization: Bearer undefined`.
3. **Stop mid-stream** → the in-flight assistant message is kept, partial text intact, composer re-enabled.
4. **Non-2xx response** → an error turn is appended (not a silent no-op), composer re-enabled.
5. **`localStorage` holds corrupt/old settings JSON** → falls back to defaults, doesn't crash on boot.

---

### Task 1: Settings store

**Files:**
- Create: `web/src/state/settings.ts`

**Interfaces:**
- Consumes: `ProtocolName` (`@lib/providers`).
- Produces: `Settings` zod schema + type (`provider`, `baseUrl`, `apiKey`, `model`, `tools`), `getSettings()`, `setSettings(patch)`, `subscribe(cb)`, `useSettings()` (a `useSyncExternalStore` hook).

- [ ] **Step 1:** Write `settings.ts` — zod `SettingsSchema` with defaults (`provider: "responses"`, `baseUrl: ""`, `apiKey: ""`, `model: ""`, `tools: []`), a `load()` that reads `localStorage["ai-client.settings"]`, `safeParse`s it and falls back to defaults on corrupt/absent JSON (Review Focus #5), and a module-level store with `subscribe`/`getSnapshot`.
- [ ] **Step 2:** Persist on every `setSettings` (merge patch, `safeParse`, write JSON).
- [ ] **Step 3:** `useSettings()` returns the snapshot via `useSyncExternalStore(subscribe, getSnapshot)`.
- [ ] **Step 4:** Verify — `bunx tsc -b --force` (exit 0), `biome check .` (clean), effect-LS (0 errors).
- [ ] **Step 5:** Commit — `feat(ui): settings store (localStorage + zod)`.

---

### Task 2: Registry — attachments + tools

**Files:**
- Modify: `web/src/lib/providers/types.ts` (add `parts`, `tools` to `SendCtx`)
- Modify: `web/src/lib/providers/responses.ts` (`buildRequest` maps them)
- Modify: `web/src/lib/providers/chatCompletions.ts` (`buildRequest` maps them)

**Interfaces:**
- Consumes: existing `Provider`, `SendCtx`.
- Produces: `AttachmentPart` (`{ kind: "image" | "file"; name: string; dataUrl: string }`); `SendCtx.parts?: AttachmentPart[]`; `SendCtx.tools?: { type: string; max_num_results: number }[]`.

- [ ] **Step 1:** Extend `SendCtx` in `types.ts` with `readonly parts?: readonly AttachmentPart[]` and `readonly tools?: readonly { type: string; max_num_results: number }[]`; export `AttachmentPart`.
- [ ] **Step 2:** In `responses.buildRequest`, append `parts` as extra `content` entries (`image` → `{ type: "input_image", file_url: dataUrl }`, `file` → `{ type: "input_file", file_url: dataUrl }`) to the user turn; merge `ctx.tools` into `body.tools` when present.
- [ ] **Step 3:** In `chatcompletions.buildRequest`, append `parts` to the user message `content` as an array of `{ type: "image_url", image_url: { url: dataUrl } }` / `{ type: "file", file: { filename: name, file_data: dataUrl } }`; merge `ctx.tools` when present.
- [ ] **Step 4:** Verify — tsc/biome/LS.
- [ ] **Step 5:** Commit — `feat(lib): attachments + tools in SendCtx/buildRequest`.

---

### Task 3: Chat store + Effect bridge

**Files:**
- Create: `web/src/state/chat.ts`

**Interfaces:**
- Consumes: `SendMsg` (`@lib/api`), `SendCtx`/`Chunk`/`AttachmentPart` (`@lib/providers/types`), `Settings`/`getSettings` (`./settings`).
- Produces: `ChatMessage` (`{ id; role: "user"|"assistant"|"error"; text: string; parts?: AttachmentPart[] }`), `getChat()`, `subscribe`, `useChat()`, `send(msg: string, parts: AttachmentPart[]): void`, `stop(): void`, `status: "idle"|"streaming"`.

- [ ] **Step 1:** Model: an array of `ChatMessage` plus a `status` flag; module-level store + `subscribe`/`getSnapshot`; `useChat()`.
- [ ] **Step 2:** `send(msg, parts)` — no-op if `status === "streaming"` or (`msg.trim() === ""` and `parts.length === 0`) (Review Focus #1); else push the user turn, push an empty assistant turn, set `streaming`, and run `SendMsg(protocol, { msg, prev, apiUrl, apiKey, parts, tools })` via `Effect.runFork` + `Stream.runForEach((chunk) => Effect.sync(() => appendChunk(chunk.text)))`; on completion or failure, finalize `status` (failure → append an error turn, Review Focus #4).
- [ ] **Step 3:** `stop()` interrupts the stored fiber; keep the partial message; reset `status` (Review Focus #3).
- [ ] **Step 4:** Read provider/baseUrl/apiKey/model/tools from the settings store at send time.
- [ ] **Step 5:** Verify — tsc/biome/LS.
- [ ] **Step 6:** Commit — `feat(ui): chat store + Effect streaming bridge`.

---

### Task 4: UI shell

**Files:**
- Create: `web/src/ui/App.tsx`, `web/src/ui/ChatPane.tsx`, `web/src/ui/Message.tsx`, `web/src/ui/Composer.tsx`, `web/src/ui/Settings.tsx`
- Modify: `web/src/main.tsx` (import `./ui/App.tsx`)
- Modify: `web/src/App.css` (app chrome) and delete the old `web/src/App.tsx`

**Interfaces:**
- Consumes: `useSettings` (Task 1), `useChat` (Task 3).
- Produces: the rendered client.

- [ ] **Step 1:** `Message` renders role + text + attachment chips.
- [ ] **Step 2:** `ChatPane` maps `useChat().messages` to `Message`s; auto-scroll to bottom while streaming.
- [ ] **Step 3:** `Composer` — textarea + send/stop button; disabled when `status === "streaming"` or send is a no-op (Review Focus #1); wires `send`/`stop`.
- [ ] **Step 4:** `Settings` — inputs bound to `useSettings`, writes patches; shows a warning when `apiKey` is empty and disables send flow (Review Focus #2).
- [ ] **Step 5:** `App` composes them; `main.tsx` imports the new path; delete `web/src/App.tsx`.
- [ ] **Step 6:** Verify — tsc/biome/LS **and** `agent-browser` smoke: app renders, composer disabled with no key, typing enables it.
- [ ] **Step 7:** Commit — `feat(ui): chat shell (App/ChatPane/Message/Composer/Settings)`.

---

### Task 5: Attachments

**Files:**
- Modify: `web/src/ui/Composer.tsx` (file input → `AttachmentPart[]`)
- Modify: `web/src/ui/Message.tsx` (render chips)

**Interfaces:**
- Consumes: `AttachmentPart` (Task 2), `send(msg, parts)` (Task 3).
- Produces: attach control feeding `send`.

- [ ] **Step 1:** Hidden `<input type="file" multiple accept="image/*,application/pdf,text/*">` + attach button; read each via `FileReader.readAsDataURL` (wrapped in `Effect.tryPromise`) into `AttachmentPart`.
- [ ] **Step 2:** Show pending-attachment chips in the composer with remove; clear on send.
- [ ] **Step 3:** `Message` renders the user turn's `parts` as chips.
- [ ] **Step 4:** Verify — tsc/biome/LS + browser smoke (attach a file → chip shows → send carries it).
- [ ] **Step 5:** Commit — `feat(ui): file/image attachments`.

---

### Task 6: Tools toggle

**Files:**
- Modify: `web/src/ui/Settings.tsx`
- Modify: `web/src/state/settings.ts` (only if the `tools` shape needs a helper)

**Interfaces:**
- Consumes: `Settings.tools` (Task 1), `SendCtx.tools` (Task 2).
- Produces: toggles that populate `Settings.tools`.

- [ ] **Step 1:** Add a "Web search" toggle (and, if useful, a `max_num_results` number) writing `tools: [{ type: "web_search_preview", max_num_results }]` (or `[]` when off).
- [ ] **Step 2:** Verify — tsc/biome/LS + browser smoke (toggle persists across reload).
- [ ] **Step 3:** Commit — `feat(ui): tools toggle`.

---

### Task 7: Tauri wrap

**Files:**
- Verify: `web/src-tauri/tauri.conf.json` (`frontendDist: "../dist"`, `devUrl`, window title)
- Modify: `web/src-tauri/tauri.conf.json` only if the title/window needs adjusting

**Interfaces:**
- Consumes: the built web app (`bun run build` → `web/dist`).
- Produces: a shell that loads the client.

- [ ] **Step 1:** `cd web && bun run build` — produces `dist/` with no errors.
- [ ] **Step 2:** `cd web/src-tauri && cargo check` — the shell compiles against the config (first build is slow; run in the background).
- [ ] **Step 3:** Confirm `tauri.conf.json` `frontendDist` = `../dist`, `beforeDevCommand`/`beforeBuildCommand` = `bun run dev` / `bun run build`, product name + window title sane.
- [ ] **Step 4:** Commit any config change — `chore(tauri): confirm shell wraps the web client`.

---

## Self-Review

- **Spec coverage:** settings → Task 1; registry parts/tools → Task 2; Effect bridge + send/stop → Task 3; components + data flow → Task 4; attachments → Task 5; tools → Task 6; Tauri → Task 7. Every spec section maps to a task.
- **Review Focus:** #1 → Task 3 Step 2 + Task 4 Step 3; #2 → Task 4 Step 4; #3 → Task 3 Step 3; #4 → Task 3 Step 2; #5 → Task 1 Step 1. All pinned.
- **Type consistency:** `Settings`, `AttachmentPart`, `ChatMessage`, `SendCtx.parts`/`tools`, `send`/`stop`/`status` names are used identically across tasks.
