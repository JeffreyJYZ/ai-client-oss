# AI Client (web + Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the desktop AI client — a dark-first, multi-conversation chat UI over the provider registry, with attachments and tools, its data persisted through a platform-adaptive `db`, wrapped by the existing Tauri shell.

**Architecture:** `src/lib/db` is an async, Effect-based store with one interface and two runtime-selected adapters — **web** (IndexedDB for conversations, localStorage for settings) and **tauri** (Rust → app-data FS, **stubbed for now**). State stores (`settings`, `chat`) hydrate from `db` on boot and write through on change, exposed via `useSyncExternalStore`. `SendMsg` runs in a forked fiber appending chunks to the active conversation; Stop interrupts it. `SendCtx` carries `model`, `parts`, `tools`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Effect 4, zod 4, IndexedDB, Tauri 2, Biome + `@effect/language-service`.

**Spec:** `docs/superpowers/specs/2026-10-09-client-web-tauri-design.md` (extended by this plan's persistence phase).

## Global Constraints

- No new dependencies; `web/src-tauri` stays stock except where a task says otherwise.
- Dark-mode first; Tailwind utilities only.
- Effect for all async; zod for validation; db API returns `Effect`s.
- **No test files** (user's call). Per-task verification = `bunx tsc -b --force` (exit 0) → `biome check .` (clean) → `bunx effect-language-service diagnostics --project tsconfig.app.json` (0 errors); UI tasks add a browser smoke via `agent-browser`.
- Source under `web/src/`; components under `web/src/ui/`, state under `web/src/state/`, storage under `web/src/lib/db/`.
- The **Tauri storage adapter is deliberately stubbed** — the interface compiles and selects web at runtime; the Rust command is a later, separate task (out of scope here).

## Review Focus

Failure modes the happy path won't exercise — each gets an explicit check in the owning task:

1. **First run / empty db** → hydration yields defaults + one empty conversation, no crash.
2. **Corrupt stored JSON** → `safeParse` fallback to defaults, no crash on boot.
3. **`localStorage`/IndexedDB unavailable or throws** → db calls fail as Effects (never throw out of a store), app still boots.
4. **Stop then immediately re-send** → the interrupted fiber's finalizer must not clobber the new run's status (identity token).
5. **`model` from settings reaches the request body** → not the template's `""`.

---

### Task 1: Settings store — COMPLETE

Done in `e1d640a` (`web/src/state/settings.ts`). Superseded by Task 5 (db-backed).

### Task 2: Registry — attachments + tools — COMPLETE

Done in `47f8ddd` (`SendCtx.parts`/`tools`, `AttachmentPart`, provider `buildRequest` mapping).

### Task 3: Chat store + Effect bridge — IN FIX

Commit `b678fb9`; review found two Important issues (dead `model`; `stop()`→`send()` finalizer race), being fixed with the `model` channel added to `SendCtx`.

---

### Task 4: `src/lib/db` — interface + web adapter

**Files:**
- Create: `web/src/lib/db/types.ts`, `web/src/lib/db/web.ts`, `web/src/lib/db/tauri.ts`, `web/src/lib/db/index.ts`

**Interfaces:**
- Consumes: the `ChatMessage` shape (from `state/chat.ts`) and the `Settings` shape (from `state/settings.ts`) — re-declare them here if needed to avoid a cycle, importing only types.
- Produces: `Conversation = { id: string; title: string; messages: ChatMessage[]; createdAt: number; updatedAt: number }`; and a `Db` interface (all `Effect`s): `listConversations(): Effect<Conversation[]>`, `getConversation(id): Effect<Option<Conversation>>`, `upsertConversation(c): Effect<void, string>`, `deleteConversation(id): Effect<void, string>`, `getSettings(): Effect<Settings>`, `setSettings(patch): Effect<void, string>`. `index.ts` exports the selected `db: Db`.

- [ ] **Step 1:** `types.ts` — the `Conversation` type and the `Db` interface.
- [ ] **Step 2:** `web.ts` — IndexedDB adapter for conversations (a `conversations` object store keyed by `id`) and `localStorage` for settings; wrap every Web API call in `Effect.tryPromise`/`Effect.try` so failures surface as typed `string` errors and never throw out (Review Focus #3). `getSettings`/`getConversation` `safeParse` and fall back to defaults on corrupt data (Review Focus #1, #2).
- [ ] **Step 3:** `tauri.ts` — a stub implementing `Db` whose methods `Effect.fail("tauri storage not implemented")` (or delegate to web); export it for later.
- [ ] **Step 4:** `index.ts` — `export const db: Db = "__TAURI_INTERNALS__" in globalThis ? tauri : web`.
- [ ] **Step 5:** Verify — tsc/biome/LS.
- [ ] **Step 6:** Commit — `feat(db): storage interface + web adapter (IndexedDB/localStorage), tauri stub`.

---

### Task 5: Settings store rework → db-backed

**Files:**
- Modify: `web/src/state/settings.ts`

**Interfaces:**
- Consumes: `db.getSettings`/`db.setSettings` (Task 4).
- Produces: the same `getSettings`/`setSettings`/`subscribe`/`useSettings` surface, now hydrated from `db` and writing through; `setSettings` still synchronous for callers (updates memory immediately, persists via `Effect.runFork`).

- [ ] **Step 1:** On module load, fork `db.getSettings()` and set the in-memory snapshot when it resolves (hydrate), notifying subscribers; until then serve defaults (Review Focus #1).
- [ ] **Step 2:** `setSettings(patch)` — merge, update memory, notify, then `Effect.runFork(db.setSettings(patch))`; a persistence failure is logged, not thrown (Review Focus #3).
- [ ] **Step 3:** Verify — tsc/biome/LS + `agent-browser`: change a setting, reload, it persists.
- [ ] **Step 4:** Commit — `refactor(ui): settings store hydrates from db`.

---

### Task 6: Chat store rework → multi-conversation + persistence

**Files:**
- Modify: `web/src/state/chat.ts`
- Modify: `web/vite.config.ts` (prerequisite: path aliases)

**Interfaces:**
- Consumes: `db.*` (Task 4); `SendMsg`, `SendCtx`, `Chunk`, `AttachmentPart`; `getSettings`.
- Produces: a conversation list + active id: `getChat()` snapshot gains `conversations: Conversation[]`, `activeId: string`, plus `newConversation()`, `selectConversation(id)`, `renameConversation(id, title)`, `deleteConversation(id)`; `send`/`stop`/`status` unchanged in behavior and now scoped to the active conversation.

- [ ] **Step 0:** Add `resolve.alias` to `web/vite.config.ts` mapping the tsconfig `paths` (`@`→`./src`, `@lib`→`./src/lib`, `@ui`→`./src/ui`, `@root`→`.`). Vite does not read tsconfig `paths` without a plugin, so the app 500s on any `@lib/*`/`@/*` import — a prerequisite for this task's browser smoke and for the UI. No new dependency.
- [ ] **Step 1:** Keep the streaming bridge and the two Task-3 fixes (identity token; `SendCtx.model`), now writing chunks into the active conversation.
- [ ] **Step 2:** Hydrate: fork `db.listConversations()`; if empty, create one; set active to the newest (Review Focus #1).
- [ ] **Step 3:** Persist: after a turn finalizes (success, failure, or interrupt), `Effect.runFork(db.upsertConversation(active))`; `newConversation`/`rename`/`delete` persist too (Review Focus #3).
- [ ] **Step 4:** `stop()` keeps the partial message and persists (Review Focus #4 stays intact — identity token).
- [ ] **Step 5:** Verify — tsc/biome/LS + `agent-browser`: send a turn, reload, the conversation is restored; create/switch/delete a conversation.
- [ ] **Step 6:** Commit — `feat(ui): multi-conversation chat store persisted via db`.

---

### Task 7: UI shell

**Files:**
- Create: `web/src/ui/App.tsx`, `ChatPane.tsx`, `Message.tsx`, `Composer.tsx`, `Settings.tsx`, `ConversationList.tsx`
- Modify: `web/src/main.tsx` (import `./ui/App.tsx`); delete `web/src/App.tsx`

**Interfaces:**
- Consumes: `useSettings` (Task 5), `useChat` (Task 6).

- [ ] **Step 1:** `Message` (role + text + attachment chips); `ChatPane` (transcript, auto-scroll while streaming).
- [ ] **Step 2:** `Composer` — textarea + send/stop; disabled when streaming or empty+no-parts (Review Focus #1); wires `send`/`stop`.
- [ ] **Step 3:** `ConversationList` — the multi-conversation sidebar (new/select/rename/delete) bound to Task 6.
- [ ] **Step 4:** `Settings` — inputs bound to `useSettings`; warn + disable send when `apiKey` is empty (Review Focus #2).
- [ ] **Step 5:** `App` composes them; `main.tsx` imports the new path; delete the old `web/src/App.tsx`.
- [ ] **Step 6:** Verify — tsc/biome/LS + `agent-browser`: renders, composer disabled with no key, sidebar lists conversations.
- [ ] **Step 7:** Commit — `feat(ui): chat shell + conversation sidebar`.

---

### Task 8: Attachments

**Files:**
- Modify: `web/src/ui/Composer.tsx`, `web/src/ui/Message.tsx`

- [ ] **Step 1:** Hidden `<input type="file" multiple accept="image/*,application/pdf,text/*">` + attach button; read each via `FileReader.readAsDataURL` (wrapped in `Effect.tryPromise`) into `AttachmentPart`; pending chips with remove; clear on send.
- [ ] **Step 2:** `Message` renders parts as chips.
- [ ] **Step 3:** Verify — tsc/biome/LS + browser (attach → chip → send carries it).
- [ ] **Step 4:** Commit — `feat(ui): file/image attachments`.

---

### Task 9: Tools toggle

**Files:**
- Modify: `web/src/ui/Settings.tsx`

- [ ] **Step 1:** A "Web search" toggle (+ `max_num_results`) writing `tools: [{ type: "web_search_preview", max_num_results }]` (or `[]`).
- [ ] **Step 2:** Verify — tsc/biome/LS + browser (toggle persists across reload).
- [ ] **Step 3:** Commit — `feat(ui): tools toggle`.

---

### Task 10: Tauri wrap

**Files:**
- Verify: `web/src-tauri/tauri.conf.json`

- [ ] **Step 1:** `cd web && bun run build` — produces `dist/`.
- [ ] **Step 2:** `cd web/src-tauri && cargo check` (background; first build slow).
- [ ] **Step 3:** Confirm `frontendDist: "../dist"`, `beforeDevCommand`/`beforeBuildCommand`, window title.
- [ ] **Step 4:** Commit any config change — `chore(tauri): confirm shell wraps the web client`.

---

## Out of scope (this plan)

- The Rust implementation of the Tauri storage adapter (stubbed in Task 4).
- Tool *execution* (declaring tools only), non-OpenAI-shaped SSE parsing, auth beyond a bearer key.
