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
- [x] **Step 6:** Verify — tsc/biome/LS + `agent-browser`: renders, composer disabled with no key, sidebar lists conversations.
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

### Task 11: Fetch models + test connection (bare paths)

**Files:**
- Create: `web/src/lib/providers/models.ts`
- Modify: `web/src/lib/providers/responses.ts` (endpoint `/v1/responses` → `/responses`)
- Modify: `web/src/lib/providers/chatCompletions.ts` (endpoint `/v1/chat/completions` → `/chat/completions`)
- Modify: `web/src/ui/Settings.tsx` (Fetch models + Test connection buttons)

**Interfaces:**
- Consumes: `Settings.baseUrl` / `apiKey`.
- Produces: `listModels(baseUrl: string, apiKey: string | undefined): Effect.Effect<string[], string>`.

- [ ] **Step 1:** `models.ts` — `listModels` GETs `${baseUrl}/models` with `Authorization: Bearer <apiKey>` when the key is set, parses `data[].id` (string[]), and `Effect.fail(String)` on non-2xx (mirror `send.ts`'s Effect pattern; no `async`/`await`/`new Promise`).
- [ ] **Step 2:** Drop `/v1` from both providers' `endpoint` fields (the base URL now carries the version).
- [ ] **Step 3:** `Settings.tsx` — a **"Fetch models"** button that fills a `<datalist>` for the existing free-text Model input; a **"Test connection"** button that runs the same call and shows `✓ Connected (N models)` or the error string; loading states on both.
- [ ] **Step 4:** Verify — tsc/biome/LS + browser smoke.
- [ ] **Step 5:** Commit — `feat(ui): fetch models + test connection; bare base-url paths`.

---

### Task 12: SSE parser — envelopes + reasoning/text tagging

**Files:**
- Modify: `web/src/lib/providers/send.ts` (parse + tag)
- Modify: `web/src/lib/providers/types.ts` (`Chunk` gains `kind`)
- Modify: `web/src/lib/db/types.ts` (`ChatMessage` gains `reasoning?`)
- Modify: `web/src/state/chat.ts` (route chunks to `reasoning` vs `text`)
- Modify: `web/src/ui/Message.tsx` (dimmed "Thinking…" block above the answer)

**Interfaces:**
- Produces: `Chunk = { kind: "text" | "reasoning"; text: string }`; `ChatMessage.reasoning?: string`.

- [ ] **Step 1:** `web/src/lib/providers/types.ts` — `Chunk` gains `readonly kind: "text" | "reasoning"`.
- [ ] **Step 2:** `web/src/lib/providers/send.ts` — `parseLine` returns a tagged chunk: a `data:` payload is parsed; **answer** = a top-level `delta` where the event `type` has no "reasoning" (Responses `response.output_text.delta`), or `choices[0].delta.content` / `choices[0].text` (chat/completions); **reasoning** = a top-level `delta` whose event `type` includes `reasoning` (Responses `response.reasoning_summary_text.delta`), or `choices[0].delta.reasoning_content` / `.reasoning` (chat/completions). Skip `[DONE]`, blanks, non-`data:` lines, and unknown shapes (`null`). Keep it total and pure.
- [ ] **Step 3:** `web/src/lib/db/types.ts` — `ChatMessage` schema + type gain `reasoning?: string`.
- [ ] **Step 4:** `web/src/state/chat.ts` — route streamed chunks: `kind === "reasoning"` appends to the assistant message's `reasoning`, `kind === "text"` to its `text`.
- [ ] **Step 5:** `web/src/ui/Message.tsx` — when `reasoning` is present, render a dimmed/collapsible "Thinking…" block above the answer text.
- [x] **Step 6:** Verify — tsc/biome/LS + a browser smoke against a **local mock SSE** that emits a reasoning event then an output event (throwaway `bun` server, not committed): the thinking appears in its own block, the answer separate, no squish.
- [ ] **Step 7:** Commit — `fix(providers): parse SSE envelopes + separate reasoning from the answer`.

---

### Task 13: Test connection → tiny real generation of the current model

**Files:**
- Modify: `web/src/lib/providers/models.ts` (add `testModel`)
- Modify: `web/src/ui/Settings.tsx` (Test connection calls it)

**Interfaces:**
- Produces: `testModel(protocol: ProtocolName, baseUrl: string, apiKey: string | undefined, model: string): Effect.Effect<void, string>`

- [ ] **Step 1:** `testModel` — POST a minimal, **1-token-capped** body to `${baseUrl}${providers[protocol].endpoint}`: `responses` → `{ model, input: "ping", stream: true, max_output_tokens: 1 }`; `chatcompletions` → `{ model, messages: [{ role: "user", content: "ping" }], stream: true, max_tokens: 1 }`. `Authorization: Bearer` when a key is set. `response.ok` → succeed; non-2xx → `Effect.fail(\`\${status}: \${body}\`)`. No `async`/`await`/`new Promise`.
- [ ] **Step 2:** `Settings.tsx` — "Test connection" calls `testModel(settings.provider, baseUrl, apiKey, model)` and shows `✓ <model> responded` or the error string. Require a non-empty model (disable/guard otherwise).
- [ ] **Step 3:** Verify — tsc/biome/LS + a browser smoke against a local mock (one 2xx, one non-2xx).
- [ ] **Step 4:** Commit — `feat(ui): test connection runs a 1-token generation of the current model`.

---

### Task 14: Built-in provider presets (OpenAI, OpenRouter, OpenCode Zen/Go, Command Code)

**Files:**
- Create: `web/src/lib/providers/presets.ts`
- Modify: `web/src/ui/Settings.tsx`

**Interfaces:**
- Produces: `PROVIDER_PRESETS: readonly { id: string; label: string; baseUrl: string; protocol: ProtocolName }[]`

- [ ] **Step 1:** `presets.ts` — `PROVIDER_PRESETS` (base URLs, all OpenAI-compatible; each is a `${baseUrl}` + bare provider path, e.g. `…/chat/completions`):
  - `openai-responses` → `https://api.openai.com/v1` + `responses`
  - `openai-chat` → `https://api.openai.com/v1` + `chatcompletions`
  - `openrouter` → `https://openrouter.ai/api/v1` + `chatcompletions`
  - `opencode-zen` → `https://opencode.ai/zen/v1` + `chatcompletions`
  - `opencode-go` → `https://opencode.ai/zen/go/v1` + `chatcompletions`
  - `opencode-go-plus` → `https://opencode.ai/zen/go/v1` + `chatcompletions` (Go Plus shares Go's endpoint; differ only by subscription limits)
  - `commandcode` → `https://api.commandcode.ai/provider/v1` + `chatcompletions`
  (No attribution headers. Code/Command Code also expose `/responses`; `chatcompletions` is the safe default, and the protocol stays switchable.)
- [ ] **Step 2:** `Settings.tsx` — a "Preset" `<select>` listing the presets plus a "Custom" option; choosing a preset sets `baseUrl` + `provider` via `setSettings`; "Custom" leaves the typed values untouched. The base URL stays editable.
- [ ] **Step 3:** Verify — tsc/biome/LS + browser smoke (pick OpenRouter → base URL + provider update, models fetch hits OpenRouter's `/models`).
- [ ] **Step 4:** Commit — `feat(ui): built-in provider presets (OpenAI, OpenRouter, OpenCode, Command Code)`.

---

### Task 15: Selecting a conversation exits Settings into the chat

**Files:**
- Modify: `web/src/ui/App.tsx`
- Modify: `web/src/ui/ConversationList.tsx`

**Interfaces:**
- Produces: `ConversationList` gains an optional `onOpenChat?: () => void` prop.

- [ ] **Step 1:** `ConversationList.tsx` — accept `onOpenChat?: () => void`; call it in BOTH the "select conversation" and "new conversation" handlers (alongside `selectConversation`/`newConversation`).
- [ ] **Step 2:** `App.tsx` — pass `onOpenChat={() => setShowSettings(false)}` to `<ConversationList />`, so picking a chat while Settings is open navigates to that chat.
- [ ] **Step 3:** Verify — tsc/biome/LS + browser smoke: open Settings, click a conversation → the chat for it shows (not Settings).
- [ ] **Step 4:** Commit — `fix(ui): selecting a conversation exits Settings into the chat`.

---

### Task 16: Multi-provider settings (providers list + active pointer)

**Files:**
- Modify: `web/src/lib/db/types.ts` (`Settings` → `{ providers: ProviderConfig[]; activeProviderId }`; add `ProviderConfig`)
- Modify: `web/src/state/settings.ts` (helpers over the list; `getActiveProvider()`)
- Modify: `web/src/state/chat.ts` (send reads the ACTIVE provider)
- Modify: `web/src/ui/Composer.tsx` (gates read the active provider)
- Modify: `web/src/ui/Settings.tsx` (provider list UI — add/edit/remove/select)

**Interfaces:**
- `ProviderConfig = { id: string; label: string; protocol: ProtocolName; baseUrl: string; apiKey: string; model: string; models: string[] }`
- `Settings = { providers: ProviderConfig[]; activeProviderId: string }` (defaults: one empty provider, active)
- `getActiveProvider(): ProviderConfig | undefined`

- [ ] **Step 1:** `lib/db/types.ts` — replace the single-provider `Settings` fields with `providers`/`activeProviderId` + add `ProviderConfig` (zod schema + type); defaults = one empty `ProviderConfig` (`protocol: "chatcompletions"`, empty base/key/model, `models: []`) with `activeProviderId` set to it.
- [ ] **Step 2:** `state/settings.ts` — keep `getSettings`/`setSettings`/`subscribe`/`useSettings`; add `getActiveProvider()` and helpers to add/update/remove/select a provider (all through `setSettings`).
- [ ] **Step 3:** `state/chat.ts` + `ui/Composer.tsx` — read `provider`/`baseUrl`/`apiKey`/`model` from the ACTIVE provider (not the flat settings).
- [ ] **Step 4:** `ui/Settings.tsx` — a provider list (label + base URL summary, add / edit / remove / select-as-active); the existing Preset, Fetch models, and Test connection buttons operate on the active provider; editing a provider writes it back into the list.
- [ ] **Step 5:** Verify — tsc/biome/LS + browser smoke: add a second provider, switch active, its base URL/key/model are used; remove one.
- [ ] **Step 6:** Commit — `feat(ui): multi-provider settings`.

---

### Task 17: Chat header — provider + model dropdowns

**Files:**
- Modify: `web/src/ui/App.tsx` (or a new `web/src/ui/ProviderPicker.tsx`)

**Interfaces:**
- Consumes: `getSettings`/`useSettings` + the active-provider helpers (Task 16).

- [ ] **Step 1:** In the chat header, a **provider `<select>`** listing `settings.providers` (value = `activeProviderId`); choosing one calls the select helper.
- [ ] **Step 2:** A **model `<select>`** for the active provider: options = its `models` (from Fetch models), value = its `model`; when `models` is empty, fall back to a free-text input so a model can still be typed. Changing it writes back to the active provider.
- [ ] **Step 3:** Verify — tsc/biome/LS + browser smoke: switch provider + model from the header, send uses them.
- [ ] **Step 4:** Commit — `feat(ui): provider + model pickers in the chat header`.

---

### Task 18: Tauri storage adapter (Rust)

**Files:**
- Modify: `web/src-tauri/src/lib.rs` (Tauri commands + `invoke_handler`)
- Modify: `web/src-tauri/Cargo.toml` (only if `serde_json`/Tauri features are missing)
- Modify: `web/src/lib/db/tauri.ts` (wire the stub to `invoke`)
- Possibly: `web/src-tauri/capabilities/default.json` (only if custom commands need an entry)

**Interfaces:**
- The tauri adapter implements the SAME `Db` via `@tauri-apps/api/core` `invoke`, storing raw JSON under `app_data_dir`:
  - `db_get_settings() -> string | null`, `db_set_settings(json: string)`
  - `db_list_conversations() -> string[]`, `db_get_conversation(id: string) -> string | null`, `db_upsert_conversation(id: string, json: string)`, `db_delete_conversation(id: string)`
- Rust takes/returns opaque JSON **strings** (no Rust structs) so the JS owns the shapes — no Rust/TS drift.

- [ ] **Step 1:** `src-tauri/src/lib.rs` — add the six `#[tauri::command]`s writing under `tauri::Manager::path().app_data_dir()` (`settings.json`, `conversations/<id>.json`); register them in `invoke_handler`. Return `Result<_, String>`.
- [ ] **Step 2:** `lib/db/tauri.ts` — replace the stub: wrap each `invoke(...)` in `Effect.tryPromise` (`catch: String`), JSON.parse/stringify, and `safeParse`-with-defaults on read (mirror the web adapter's behavior).
- [ ] **Step 3:** Verify — `cd web/src-tauri && cargo build` (compiles) + `bunx tsc -b --force` / `biome check .` / effect-LS; then `cd web && bunx tauri dev`, add a provider, close, relaunch, and confirm it persisted.
- [ ] **Step 4:** Commit — `feat(tauri): persist conversations + settings via Rust`.

---

### Task 19: System prompt (per conversation)

**Files:**
- Modify: `web/src/lib/db/types.ts` (`Conversation` gains `systemPrompt?: string`)
- Modify: `web/src/lib/providers/types.ts` (`SendCtx` gains `systemPrompt?: string`)
- Modify: `web/src/lib/providers/responses.ts` (apply it)
- Modify: `web/src/lib/providers/chatCompletions.ts` (apply it)
- Modify: `web/src/state/chat.ts` (pass the active conversation's prompt; a setter)
- Modify: `web/src/ui/` (a compact per-conversation editor — chat header or a Settings section)

**Interfaces:**
- `SendCtx.systemPrompt?: string`; `Conversation.systemPrompt?: string`.

- [ ] **Step 1:** `Conversation` (zod + type) gains `systemPrompt?: string`.
- [ ] **Step 2:** `SendCtx` gains `systemPrompt?: string`; `responses.buildRequest` sets `instructions` from it; `chatcompletions.buildRequest` prepends `{ role: "system", content }` to `messages` when set. Keep both pure.
- [ ] **Step 3:** `chat.ts` — the send passes the active conversation's `systemPrompt`; add a setter that updates it (persisted via the existing conversation write-through).
- [ ] **Step 4:** UI — a compact editor for the active conversation's system prompt (e.g. a "System" textarea reachable from the chat header / a small panel). Dark-first.
- [ ] **Step 5:** Verify — tsc/biome/LS + browser smoke against a local mock: with a system prompt set, the request body carries it (`instructions` for responses, a `system` message for chatcompletions).
- [ ] **Step 6:** Commit — `feat: per-conversation system prompt`.

---

### Task 20: Profiles (provider + model + system prompt)

**Files:**
- Modify: `web/src/lib/db/types.ts` (`Settings` gains `profiles: Profile[]`; `Profile` type)
- Modify: `web/src/state/settings.ts` (helpers)
- Modify: `web/src/state/chat.ts` (applying a profile)
- Modify: `web/src/ui/App.tsx` (a profiles picker in the chat header)
- Modify: `web/src/ui/Settings.tsx` (manage profiles)

**Interfaces:**
- `Profile = { id: string; name: string; providerId: string; model: string; systemPrompt: string }`; `Settings.profiles: Profile[]`.

- [ ] **Step 1:** `Settings` (zod + type) gains `profiles: Profile[]` (default `[]`); add `Profile`.
- [ ] **Step 2:** `state/settings.ts` — helpers to add/update/remove a profile (via `setSettings`).
- [ ] **Step 3:** Applying a profile (chat header picker): `setSettings({ activeProviderId: profile.providerId })`, write `profile.model` into that provider's `model`, and set the active conversation's `systemPrompt` to `profile.systemPrompt`.
- [ ] **Step 4:** UI — a **profiles `<select>`** in the chat header (apply one); add/edit/delete profiles in `Settings.tsx` (name + provider + model + system prompt).
- [ ] **Step 5:** Verify — tsc/biome/LS + browser smoke: pick a profile → provider, model, and system prompt all switch.
- [ ] **Step 6:** Commit — `feat: profiles (provider + model + system prompt)`.

---

### Task 21: Per-provider tools (fix the OpenAI-only web-search 400)

**Files:**
- Modify: `web/src/lib/db/types.ts` (`ProviderConfig` gains `tools`; drop the global `Settings.tools`)
- Modify: `web/src/lib/providers/presets.ts` (each preset carries a default `tools`)
- Modify: `web/src/state/settings.ts` (helpers read/write the active provider's tools)
- Modify: `web/src/state/chat.ts` (send uses the ACTIVE provider's `tools`)
- Modify: `web/src/ui/Settings.tsx` (the Web search toggle edits the active provider)

**Interfaces:**
- `ProviderConfig.tools: { type: string; max_num_results: number }[]` (moved off `Settings`).

- [ ] **Step 1:** `types.ts` — add `tools` to `ProviderConfig` (default `[]`); remove the global `Settings.tools`.
- [ ] **Step 2:** `presets.ts` — `ProviderPreset` gains an optional `tools`; OpenAI presets default to `[{ type: "web_search_preview", max_num_results: 5 }]`, all others to `[]` (OpenCode/Command Code/OpenRouter reject built-ins).
- [ ] **Step 3:** `chat.ts` — the send passes `activeProvider.tools`.
- [ ] **Step 4:** `Settings.tsx` — the Web search toggle + `max_num_results` edit the ACTIVE provider's `tools` (per-provider), with a hint that it's endpoint-specific.
- [ ] **Step 5:** Rename the two OpenAI preset labels to `"OpenAI-compatible (Responses)"` / `"OpenAI-compatible (Chat Completions)"` (`presets.ts`), and the provider-label placeholder in `Settings.tsx` from `"OpenAI"` to `"OpenAI-compatible"` — the protocol is a *format*, not the vendor.
- [x] **Step 6:** Verify — tsc/biome/LS + a browser smoke: a Command Code provider with the toggle OFF sends no `tools` (no 400); an OpenAI provider with it ON sends the built-in.
- [ ] **Step 7:** Commit — `fix(ui): per-provider tools + OpenAI-compatible labels`.

---

### Task 22: Guard `prev` across protocol/provider switches

**Files:**
- Modify: `web/src/state/chat.ts`

**Interfaces:**
- `prev` becomes keyed by `(conversationId, protocol)` instead of `conversationId`.

- [ ] **Step 1:** Key the in-memory `prev` map by `${conversationId}\u0000${protocol}` (or an equivalent composite), so each protocol has its own accumulated body; a protocol switch finds no entry and falls back to the template.
- [ ] **Step 2:** Confirm the map is pruned on conversation delete for every protocol.
- [ ] **Step 3:** Verify — tsc/biome/LS + a browser smoke: set a `prev` under `responses`, switch the active provider to a `chatcompletions` one, and send — no throw, a clean request.
- [ ] **Step 4:** Commit — `fix(ui): scope prev per protocol so a protocol switch can't replay a foreign body`.

---

### Task 23: Confirm destructive actions

**Files:**
- Create: `web/src/ui/ConfirmButton.tsx`
- Modify: `web/src/ui/Settings.tsx` (provider remove + profile delete)
- Modify: `web/src/ui/ConversationList.tsx` (conversation delete)

**Interfaces:**
- Produces: `ConfirmButton({ label, confirmLabel, onConfirm, className? })` — an inline two-step confirm (first click arms, second executes; blur/Escape/click-away disarms). No `window.confirm` (platform-dependent in the webview); no modal dependency.

- [ ] **Step 1:** `ConfirmButton.tsx` — a self-contained two-step button (default `label` → armed `confirmLabel`, resets on blur/Escape; dark-first Tailwind; `aria-live` on the armed state).
- [ ] **Step 2:** `Settings.tsx` — use it for the provider **remove** and the profile **delete** (Task 20), replacing the single-click destructive buttons.
- [ ] **Step 3:** `ConversationList.tsx` — use it for the conversation **delete** (currently one click).
- [ ] **Step 4:** Verify — tsc/biome/LS + browser smoke: the first click arms (no deletion), the second deletes; clicking away cancels; a conversation and a provider both require two clicks.
- [ ] **Step 5:** Commit — `feat(ui): confirm destructive actions (provider/profile/conversation removal)`.

---

### Task 24: Fold the Go Plus preset into the Go row

**Files:**
- Modify: `web/src/lib/providers/presets.ts`

- [ ] **Step 1:** Remove the `opencode-go-plus` preset (it is configurationally identical to `opencode-go` — same base URL + protocol — so it only duplicated the row and collapsed to the same label).
- [ ] **Step 2:** Relabel `opencode-go` → `"OpenCode Go / Go Plus"` (they share the endpoint; Go Plus differs only by subscription usage limits).
- [ ] **Step 3:** Verify — tsc/biome/LS + a browser smoke: one Go row remains, labelled with Both.
- [ ] **Step 4:** Commit — `fix(ui): fold Go Plus into the OpenCode Go preset`.

---

### Task 25: chat/completions must request a stream

**Files:**
- Modify: `web/src/lib/providers/chatCompletions.ts`
- Optionally: `web/src/lib/providers/responses.ts` (belt-and-braces), `web/src/lib/types/protocols.ts` (`ChatCompletionsSend` gains `stream?`)

- [ ] **Step 1:** In `chatCompletions.buildRequest`, set `stream: true` explicitly on the returned body (like `responses` already does via its template), so the endpoint streams SSE instead of returning one JSON blob.
- [ ] **Step 2:** Belt-and-braces: confirm `responses.buildRequest` always emits `stream: true` too (explicit, not only from the template).
- [ ] **Step 3:** Verify — tsc/biome/LS + a browser smoke against a mock that returns NON-streamed JSON when `stream` is absent and SSE `data: {"choices":[{"delta":{"content":"…"}}]}` when present: with the fix, text streams.
- [ ] **Step 4:** Commit — `fix(providers): chat/completions must request a stream (silent otherwise)`.

---

### Task 26: App mark — favicon (web + desktop) + Tauri window title

**Files:**
- Create: `web/public/favicon.svg`
- Modify: `web/index.html` (icon link)
- Modify: `web/src-tauri/tauri.conf.json` (window title)
- Regenerate: `web/src-tauri/icons/*` (via `bunx tauri icon`)

- [ ] **Step 1:** `web/public/favicon.svg` — a minimal **geometric** mark (a diamond/hexagon), `neutral-200` on a near-black (`#0a0a0a`) rounded square, `viewBox="0 0 32 32"`, no text.
- [ ] **Step 2:** `web/index.html` — add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` (plus a PNG/`.ico` fallback if trivially available).
- [ ] **Step 3:** Rasterize the SVG to a 1024×1024 PNG using whatever is installed (`qlmanage -t -s 1024 -o <dir>` on macOS, `rsvg-convert`, or `magick`), then `bunx tauri icon <png>` to regenerate `web/src-tauri/icons/`.
- [ ] **Step 4:** `web/src-tauri/tauri.conf.json` — set `app.windows[0].title` to `"Open Source AI Client"`.
- [ ] **Step 5:** Verify — `bunx tsc -b --force` / `biome check .` / effect-LS; a browser smoke shows the tab icon; `bunx tauri dev` shows the window title.
- [ ] **Step 6:** Commit — `feat: app mark (geometric favicon) + Tauri window title`.

---

### Task 27: Responsive header title

**Files:**
- Modify: `web/src/ui/App.tsx`

- [ ] **Step 1:** The header `<h1>` shows the full `"Open Source AI Client"` on wider screens and shrinks to `"OSS AI Client"` when the viewport is small (e.g. two spans toggled by a Tailwind breakpoint: `hidden sm:inline` for the long form, `sm:hidden` for the short — or the equivalent). Keep the existing mono/uppercase/`tracking-widest` styling.
- [ ] **Step 2:** Verify — tsc/biome/LS + a browser smoke via `agent-browser`: at a wide viewport the tab shows "Open Source AI Client"; shrunk narrow it shows "OSS AI Client".
- [ ] **Step 3:** Commit — `feat(ui): shrink the header title to "OSS AI Client" on narrow screens`.

---

### Task 28: Don't yank the transcript while streaming

**Files:**
- Modify: `web/src/ui/ChatPane.tsx`

- [ ] **Step 1:** Track whether the user is "pinned to the bottom" (e.g. a ref updated on `onScroll`: pinned when `scrollHeight - scrollTop - clientHeight` is under a small threshold). Auto-scroll to the bottom on new content ONLY while pinned. When the user has scrolled up, do NOT force-scroll — let them read.
- [ ] **Step 2:** (Optional) a small "jump to latest" affordance when unpinned — only if cheap.
- [ ] **Step 3:** Verify — tsc/biome/LS + a browser smoke via `agent-browser`: start a long reply, scroll up mid-stream → the view stays put; scroll back to the bottom → it follows again.
- [ ] **Step 4:** Commit — `fix(ui): don't force-scroll the transcript while streaming if the user scrolled up`.

---

### Task 29: Break and mark the tool-call seam

**Files:**
- Modify: `web/src/lib/providers/types.ts` (`Chunk.kind` gains `"tool"`)
- Modify: `web/src/lib/providers/send.ts` (recognize tool-call deltas; stop tagging Responses function-call arguments as answer text)
- Modify: `web/src/state/chat.ts` (break the answer run + render a marker at the boundary)

**Interfaces:**
- Extends: `Chunk = { kind: "text" | "reasoning" | "tool"; text: string }` — for `"tool"`, `text` is the tool/function name.

- [ ] **Step 1:** `types.ts` — `Chunk.kind` gains `"tool"` (doc: `text` carries the function name).
- [ ] **Step 2:** `send.ts` — `parseLine` emits `{ kind: "tool", text: <name> }` for a chat/completions `choices[0].delta.tool_calls[…]` whose `function.name` is non-empty (argument-only continuations carry no name → `null`), a Responses `output_item.added` item typed `function_call`, and a Responses `web_search_call.*.in_progress`. Returns `null` — **not** answer text — for `response.function_call_arguments.delta` (previously mistagged `text`, leaking the raw arguments JSON into the reply).
- [ ] **Step 3:** `chat.ts` — `appendChunk` routes `kind: "tool"`: append a display-only marker line to `text` (`🔍 searched the web` when the name matches `/search/i`, else `🔧 <name>`) fenced by blank lines, so the pre-call and post-call runs no longer glue. `assistantText` (the next-turn seed) accumulates `kind === "text"` only, so the marker never reaches the wire.
- [ ] **Step 4:** Verify — tsc/biome/LS + a browser smoke against a throwaway mock SSE (`content` → a `tool_calls` delta → `content`): the marker sits **between** the two runs, and the mock's logged next request body contains no marker.
- [ ] **Step 5:** Commit — `fix(providers): break and mark the tool-call seam`.

---

### Task 31: Per-endpoint web search (kill the phantom tool)

**Files:**
- Modify: `web/src/lib/providers/types.ts` (`SearchKind`, `SearchSpec`, `SendCtx.search`)
- Modify: `web/src/lib/providers/presets.ts` (`searchKindFor`)
- Modify: `web/src/lib/providers/responses.ts` + `chatCompletions.ts` (send the endpoint's own mechanism)
- Modify: `web/src/state/chat.ts` (derive `search` from the active provider)
- Modify: `web/src/ui/Settings.tsx` (disable the toggle where search cannot work)
- Modify: `web/src/lib/db/types.ts` (update the `tools` doc comment)

**Why:** the Web-search toggle wrote OpenAI's built-in `web_search_preview` for *every* endpoint, but only OpenAI executes it. On OpenRouter (real search = `plugins:[{id:"web",max_results}]`) and OpenCode/Command Code (no server-side search) the model got a tool nothing runs → it believed it had searched and answered from its training cutoff (a 2025 reply).

- [ ] **Step 1:** `types.ts` — `export type SearchKind = "openai" | "openrouter"`; `export interface SearchSpec { kind: SearchKind; maxResults: number }`; `SendCtx` gains `search?: SearchSpec` (keep `tools`).
- [ ] **Step 2:** `presets.ts` — `searchKindFor(baseUrl): SearchKind | null` (`openrouter.ai` → `"openrouter"`, `api.openai.com` → `"openai"`, else `null`). Preset `tools` defaults unchanged.
- [ ] **Step 3:** `responses.ts` / `chatCompletions.ts` — send `tools: ctx.tools` **only** when `ctx.search?.kind === "openai"`; for `"openrouter"` send `plugins: [{ id: "web", max_results }]` instead. Explicit keys, so nothing replayed from `prev` leaks.
- [ ] **Step 4:** `chat.ts` — `search` present only when the endpoint has a mechanism and the provider's `tools` is non-empty.
- [ ] **Step 5:** `Settings.tsx` — toggle `disabled` + a hint when `searchKindFor(baseUrl)` is `null`; an OpenRouter hint that search is billed by OpenRouter.
- [x] **Step 6:** Verify — tsc/biome/LS + a mock-SSE smoke asserting the request body per endpoint.
- [ ] **Step 7:** Commit — `fix(providers): per-endpoint web search (OpenRouter plugin; no phantom tool)`.

---

### Task 32: Export / import a backup file (desktop ↔ website)

**Files:**
- Create: `web/src/lib/backup.ts` (schema + `exportBackup`/`importBackup`)
- Modify: `web/src/ui/Settings.tsx` (a Backup section)

**Interfaces:**
- `backupSchema = z.object({ version: z.literal(1), exportedAt: z.string(), settings: Settings, conversations: z.array(conversationSchema) })`.
- `exportBackup(): Effect.Effect<Backup, string>` — `db.getSettings()` + `db.listConversations()`.
- `importBackup(raw: unknown): Effect.Effect<{ conversations: number }, string>` — validate, `db.setSettings(backup.settings)`, then `db.upsertConversation` for each conversation (additive; never deletes).

- [ ] **Step 1:** `lib/backup.ts` — the zod schema (reuse `Settings`/`conversationSchema` from `@lib/db/types`), `exportBackup`, and `importBackup` (a bad payload fails with a readable message; storage untouched).
- [ ] **Step 2:** `Settings.tsx` — a Backup section: **Export** (a `.json` download plus a Copy-to-clipboard fallback, since a webview may not surface the download) and **Import** (a file input read via `Effect.callback` + `FileReader.readAsText`), with an inline status/error line and a warning that the file contains API keys.
- [ ] **Step 3:** On a successful import, `window.location.reload()` so both stores re-hydrate from `db` — no partial in-memory state.
- [ ] **Step 4:** Verify — gates + a browser round-trip.
- [ ] **Step 5:** Commit — `feat: export/import a backup file (settings + conversations)`.

---

### Task 33: Markdown rendering for answers

**Files:**
- Modify: `web/package.json`, `web/bun.lock` (add `marked` + `dompurify`)
- Create: `web/src/ui/Markdown.tsx`
- Modify: `web/src/ui/Message.tsx` (answer body only; reasoning stays plain)
- Modify: `web/src/App.css` (`.md` styles)

**Why:** answers render as `whitespace-pre-wrap` plain text, so `## headings`, tables and code fences show literally.

- [ ] **Step 1:** add `marked` + `dompurify` (registry latest, pinned deliberately); `@types/dompurify` only if the installed version lacks its own types.
- [ ] **Step 2:** `Markdown.tsx` — `marked` (GFM, `breaks: true`) → `DOMPurify.sanitize` → `dangerouslySetInnerHTML` in a `.md` div; a fenced code block gets a **copy** button (injected after sanitizing; the click handler reads the sibling `<code>`'s text and copies it).
- [ ] **Step 3:** `Message.tsx` — the answer uses `<Markdown text={message.text} />`; the reasoning `<details>` stays plain.
- [ ] **Step 4:** `App.css` — dark-first styles for headings, lists, links, inline/`pre` code, tables, blockquotes, `hr`.
- [ ] **Step 5:** Verify — gates + a browser render of a markdown answer **including an XSS attempt** (`<img src=x onerror=…>`, `<script>`): the structure renders, the copy button works, and no handler/script survives sanitizing.
- [ ] **Step 6:** Commit — `feat(ui): render answers as markdown`.

---

### Task 34: Local models work without an API key

**Files:**
- Modify: `web/src/lib/providers/presets.ts` (Ollama + LM Studio presets)
- Modify: `web/src/lib/providers/send.ts` (no empty `Bearer`)
- Modify: `web/src/state/chat.ts`, `web/src/ui/Composer.tsx`, `web/src/ui/Settings.tsx` (key not required for a localhost endpoint)

**Why:** the composer and Settings both refuse to send without a non-empty API key, so a local server (Ollama `:11434/v1`, LM Studio `:1234/v1`) is unusable; an empty key also emits `Authorization: Bearer `.

- [ ] **Step 1:** `presets.ts` — `ollama` (`http://localhost:11434/v1`, chatcompletions, no tools) and `lmstudio` (`http://localhost:1234/v1`); a localhost helper for "needs no key".
- [ ] **Step 2:** `send.ts` — send the `Authorization` header only for a non-empty key.
- [ ] **Step 3:** `Composer.tsx` / `Settings.tsx` — a localhost endpoint does not count as a missing key; hint that the desktop build (or `OLLAMA_ORIGINS`) is needed for local models from a browser.
- [ ] **Step 4:** Verify — gates + a browser smoke: a localhost provider with an empty key can send, and the request carries no `Authorization` header.
- [ ] **Step 5:** Commit — `feat(providers): local endpoints need no API key`.

---

### Task 35: New-version notice (desktop only)

**Files:** create `web/src/lib/updates.ts`, `web/src/ui/UpdateNotice.tsx`; modify `web/src/ui/App.tsx`.

**Why:** nothing tells a desktop user that a newer release exists; every update means noticing by chance and re-downloading.

- [ ] **Step 1:** `updates.ts` — `latestVersion()` (GET `releases/latest` via `GITHUB_REPOSITORY` from `@/constants/links`, strip the `desktop-v` prefix) and a pure `isNewer(latest, current)` semver compare.
- [ ] **Step 2:** `UpdateNotice.tsx` — desktop only: read the running version with `getVersion()`, compare, and render a dismissible strip linking to `LATEST_RELEASE_URL`. A failed check is silent; it never blocks the app.
- [ ] **Step 3:** `App.tsx` — render it beside the existing install note.
- [ ] **Step 4:** Verify — gates + `isNewer` truth table + the web build showing nothing.
- [ ] **Step 5:** Commit — `feat(ui): tell desktop users when a newer version exists`.

---

### Task 36: Tauri auto-updater

**Files:** `web/src-tauri/Cargo.toml`, `web/src-tauri/src/lib.rs`, `web/src-tauri/capabilities/*`, `web/src-tauri/tauri.conf.json`, `.github/workflows/release-tauri.yml`, plus the Task 35 UI.

**Why:** real in-app updates once the builds are signed; the updater's own signature is independent of Apple/Windows code signing.

- [x] **Step 1:** `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS); register the plugin and add the capability.
- [x] **Step 2:** `tauri.conf.json` — `bundle.createUpdaterArtifacts: true` and `plugins.updater` (endpoints + the **public** key). The private key never enters the repo.
- [x] **Step 3:** `release-tauri.yml` — pass `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` from secrets so tauri-action publishes the `.sig` files and `latest.json`.
- [x] **Step 4:** UI — when a newer version exists, offer Download & install, then relaunch.
- [x] **Step 5:** Verify — `cargo check` + gates; the signed flow needs the secret, so it is proven on the first release after the key is set.
- [x] **Step 6:** Commit — `feat: in-app updates via the Tauri updater`.

**Human step (done):** the keypair exists at `~/.tauri/ai-client.key` (+ its password file, both 600) and the two repo secrets are set; never print or commit either.

---

### Task 37: Anthropic-compatible Messages protocol

**Files:** create `web/src/lib/providers/anthropicMessages.ts`; modify `providers/index.ts`, `providers/send.ts`, `providers/presets.ts`, `lib/types/protocols.ts`, `lib/core/parse.ts`, `ui/Settings.tsx` (protocol label).

**Why:** only the two OpenAI wire formats exist, so Anthropic's Messages API (and the many gateways that proxy it) cannot be used at all.

- [x] **Step 1:** `anthropicMessages.ts` — a `Provider` implementing the Messages API. **Verify every wire detail against the current Anthropic docs (fetch them) before coding** — this is a new format and a local mock can only prove the code matches whatever you assumed.
- [x] **Step 2:** auth differs: `x-api-key` (not `Bearer`) plus `anthropic-version`, and the header that lets a browser call it. `sendStream` must take per-provider headers.
- [x] **Step 3:** `max_tokens` is required by the API and the app has no such setting, so ship a named default constant. The system prompt is a top-level `system` field, not a message.
- [x] **Step 4:** SSE — the events are Anthropic's, not OpenAI's: text and thinking arrive as different delta types, and tool/server-tool use announces itself on a content-block start. Map them onto the existing `Chunk` kinds.
- [x] **Step 5:** register the protocol, add a preset (`Anthropic-compatible (Messages)`), and teach `searchKindFor`/`searchTools` the provider's server-side web-search tool.
- [x] **Step 6:** Verify — gates + a mock server replaying the **documented** event sequence, asserting the chunk stream, plus the built request body.
- [x] **Step 7:** Commit — `feat(providers): Anthropic-compatible Messages protocol`.

---

### Task 38: Long-term memory (notes)

**Files:** create `web/src/lib/memory.ts`; modify `lib/db/types.ts`, `state/chat.ts`, `ui/Settings.tsx`.

**Why:** every conversation starts from nothing; the app should carry durable facts about the user across sessions.

- [x] **Step 1:** Storage — `Settings.memories` (id, text, createdAt, source) plus `memoriesEnabled`, zod-defaulted so an existing stored settings file still parses, and carried by the existing export/import backup. Global, not per-conversation.
- [x] **Step 2:** `memory.ts` — `extractMemories` (pure: removes complete memory tags, hides an unterminated one), `mergeMemories` (dedupe + cap, clock passed in), `memoryPrompt` (the model instruction plus the current notes; empty string when there are none). Named constants, never a repeated literal.
- [x] **Step 3:** `state/chat.ts` — inject `memoryPrompt` into the outgoing system prompt only (never into the stored conversation), and run the accumulating reply through `extractMemories` so the tag never reaches the UI or the store; persist completed notes when the stream ends. Re-extraction must be a no-op.
- [x] **Step 4:** `ui/Settings.tsx` — a Memory section: enable toggle, the notes with delete, an add field.
- [x] **Step 5:** Verify — gates; a throwaway script proving the pure functions (deleted after, never committed); the UI driven in a browser.
- [x] **Step 6:** Commit — `feat: long-term memory notes`.

**Design note:** deliberately no tool calling — see "Tool *execution*" under out of scope. The model records a fact by ending its reply with a tag the app strips, so one mechanism works on all three protocols and nothing needs a tool-execution loop.

---

### Task 39: Model-requested URL fetch (`fetch_url` tool)

**Files:** create `web/src/lib/fetch.ts`; modify `web/src-tauri/src/lib.rs`, `web/src-tauri/Cargo.toml`, `lib/providers/types.ts`, `lib/providers/send.ts`, `lib/providers/presets.ts`, `lib/providers/{chatCompletions,responses,anthropicMessages}.ts`, `state/chat.ts`, `ui/Message.tsx`, `ui/Settings.tsx`, `lib/db/types.ts`.

**Why:** the model can only talk about a page if the user pastes its text — it has no way to ask for a URL. This is the first task that *executes* a tool (tool execution was out of scope until now): exactly one narrow tool, not a general loop.

**Dependency note:** adds two *direct* Rust crates — `reqwest` (`default-features = false, features = ["rustls-no-provider"]`) and `rustls` (`ring`). The lock resolves reqwest to **0.13.5**, where the old `rustls-tls` feature no longer exists, and the no-provider build needs a `ring` crypto provider installed once at runtime. Both are already in `Cargo.lock` via `tauri-plugin-updater`, so the tree must not grow — `git diff --stat Cargo.lock` shows only the two new direct-dependency lines.

- [x] **Step 1:** Rust transport — `fetch_url(url)`: GET with a desktop user agent, a timeout and a response-size cap (named constants), `http`/`https` only, every failure a `Result::Err(String)` and never a panic. `async fn` with `reqwest`'s async client so the UI thread is never blocked; register it in `generate_handler!`.
- [x] **Step 2:** `web/src/lib/fetch.ts` — `fetchUrlText(url): Effect<string, string>`. Desktop invokes the command (mirror how `lib/db/tauri.ts` imports `@tauri-apps/api/core`, and select with `isDesktop` from `lib/platform.ts`); the web build uses `fetch` and turns a network/CORS failure into a plain sentence rather than a raw `TypeError`.
- [x] **Step 3:** `htmlToText(html)` — pure: drop `script`/`style`/`head`, tags to whitespace, decode the common entities, collapse runs, cap at a named character limit with an explicit truncation note. No new dependency.
- [x] **Step 4:** Declare the tool per wire shape in `presets.ts` — `fetchToolSpec(kind)` returns what each endpoint wants (`{type:"function",function:{…}}` for chat/completions, the flat `{type:"function",name,…}` for Responses, `{name,input_schema}` for Anthropic) with a one-property JSON schema (`url`, required). Merge with the search declaration so one request can carry both.
- [x] **Step 5:** Parse the call — extend `Chunk` with the call envelope (id, name, arguments) and accumulate per protocol: chat/completions streams `tool_calls[].function.arguments` in pieces and completes on `finish_reason: "tool_calls"`; Responses carries the whole string on `function_call_arguments.done`; Anthropic accumulates `input_json_delta.partial_json` and closes on `content_block_stop`. The per-line parser stays pure; accumulation lives in the stream builder.
- [x] **Step 6:** `appendToolResult` on every provider, plus the loop in `chat.ts`: when a run settles with calls pending, fetch each (bounded by named max calls per turn and max rounds), append the results to the body, mark each result in the transcript (display-only — never on the wire), and re-send with the extended body. `stop` must interrupt a fetch in flight, and the finalizer still respects the run-identity token. The body of every round must carry the user message exactly once: a round that re-appends it repeats the question at the model (landed as `SendCtx.skipUserMessage`, set from round 2 on).
- [x] **Step 7:** Settings toggle `fetchToolEnabled` (zod-defaulted so a stored settings file still parses) and the transcript marker for both a successful and a failed fetch.
- [ ] **Step 8:** Verify — gates, then a local mock endpoint that answers with a tool call followed by a final answer, driven in a browser, proving the loop closes and the fetched text reaches the second request. The Rust path is compile-verified here; the desktop smoke is the user's, because a Tauri window is a WKWebView and agent-browser cannot drive it.
- [x] **Step 9:** Commit — `feat: model-requested URL fetch`.

**Design note:** the tool result is appended to the request body, not stored as a `ChatMessage` — the transcript keeps a display-only marker (the same seam Task 29 established for tool calls), so the DB schema and every wire shape stay untouched. Deliberately do *not* echo reasoning back for tool continuity: OpenRouter recommends preserving `reasoning_details` across a tool call, but the chunk pipeline flattens reasoning to plain text, so the structured blocks are gone by then — that continuity is not worth restructuring the pipeline for.

---

### Task 40: Thinking streams — the `reasoning_details` shape and live progress

**Files:** modify `lib/providers/send.ts`, `ui/Message.tsx`.

**Why:** a mock-SSE repro (identical 250 ms pacing for reasoning and answer, driven in a browser) split the report in two:

- OpenRouter's newer `reasoning_details` shape renders **no thinking at all**: `parseLine` reads only `delta.reasoning_content ?? delta.reasoning`, so those deltas parse to `null` and are filtered out — 0 of 12 reasoning words reached the page.
- The client's read→paint path does **not** lump: with the handled shape, one event painted per event, as smoothly as the answer. So a "few big jumps" off the wire is the endpoint's own emission pattern (a model sending coarse `reasoning` beside fine `reasoning_details`), not the render loop.
- Independent of both: in-progress thinking is invisible — the `<details>` is closed by default and its `<summary>` is a static "Thinking…", so the screen shows nothing moving while the model thinks.

- [x] **Step 1:** `parseLine` — also read `reasoning_details`. **Verify every item shape against OpenRouter's current docs before coding** (a text item carries `text`, a summary item `summary`, an encrypted item carries nothing renderable). When one delta carries both fields, prefer the structured one so the same text is never appended twice. Stays pure.
- [x] **Step 2:** the collapsed row shows progress: the summary carries the thinking's growing size, so a reader sees the model working without expanding the box.
- [x] **Step 3:** Verify — re-run the mock-SSE harness (it already drives both shapes) and assert the box appears for the `reasoning_details` shape and that its text grows event by event; then the usual gates.
- [x] **Step 4:** Commit — `fix: read OpenRouter reasoning_details so thinking streams`.

---

### Task 41: TinyFish search and fetch (API key)

**Files:** create `web/src/lib/tinyfish.ts`; modify `web/src-tauri/src/lib.rs`, `lib/providers/presets.ts`, `lib/providers/types.ts`, `lib/fetch.ts`, `state/chat.ts`, `ui/Settings.tsx`, `lib/db/types.ts`.

**Why:** search exists only where the endpoint provides it — local models and Command Code have none at all — and a page fetch is a blind HTTP GET that runs no scripts. TinyFish (search and fetch are free; the key comes from `agent.tinyfish.ai/api-keys`) fills both, client-side, for every endpoint.

**Wire (docs-verified):** auth is the `X-API-Key` header. Search is `GET https://api.search.tinyfish.ai?query=…`, answering `{results:[{position,site_name,title,snippet,url}],…}`. Fetch is `POST https://api.fetch.tinyfish.ai` with `{urls:[…], format?: "markdown", ttl?}`, answering `{results:[{url,…,text,format}],errors:[{url,error,status?}]}`. **A per-URL failure rides inside a 200 in `errors[]`** — reading only `results` turns a failed fetch into an empty success, which is the exact bug the plain fetch just had fixed, so `errors[]` must reach the tool result as a sentence. Search takes 1-3s, fetch 1-20s, with a 110s per-URL backend timeout and a 120s CDN ceiling; the docs tell clients to allow 150s, which is why the Rust command carries its own timeout rather than the page fetch's 30s. Free allowance: 12k searches/day, 1k fetches/day (automation is the metered part).

- [x] **Step 1:** Rust: one generic `http_request(method, url, headers, body)` command — reusing the existing client, with its own longer timeout and the same size cap and string-error style — so the desktop reaches TinyFish with no CORS limit. `fetch_url` stays exactly as it is.
- [x] **Step 2:** `lib/tinyfish.ts` — `searchWeb(query)` and `fetchPage(url)`, returning compact text (search: title/url/snippet per result; fetch: the extracted content, capped), each mapping every failure to a sentence. Desktop through the new command, web through `fetch` with the same best-effort CORS wording as `lib/fetch.ts`.
- [x] **Step 3:** `Settings.tinyfishApiKey` — zod-defaulted so a stored settings file still parses, masked in the UI, with a link to the key page and a line noting search and fetch are free. It rides export/import like the provider keys.
- [x] **Step 4:** Declare `web_search` (a required `query`) beside `fetch_url`, in each wire shape as Task 39 established. TinyFish search is declared **only** where the endpoint has no native mechanism — the endpoint's own search wins, TinyFish fills the gap — and only while the per-provider search toggle is on. **Trap: that toggle is currently disabled for endpoints with no mechanism, which is exactly where TinyFish is the only source of search, so the declaration could never fire there — make the control live wherever TinyFish can serve the request (a key is set).** The fetch tool's routing changes: with a key, TinyFish first, the app's own fetch as the fallback.
- [x] **Step 5:** `state/chat.ts` — dispatch by tool name in the loop (`fetch_url`, `web_search`), validating each call's arguments the way the URL is validated today, marking each outcome in the transcript, and keeping the round bounds.
- [x] **Step 6:** Verify — gates; a mock TinyFish API (a page-level `fetch` override, as Task 40's live run used, since the base URL is a constant) proving search results reach the second request, that fetch prefers TinyFish and falls back when it errors, and that no key means no search declaration; plus `cargo check --all-targets`.
- [x] **Step 7:** Commit — `feat: TinyFish search and fetch`.

---

### Task 42: Multi-turn context must survive a reload

**Files:** modify `state/chat.ts`, `lib/db/types.ts`, `ui/Message.tsx`, `lib/providers/{chatCompletions,responses,anthropicMessages}.ts`.

**Why:** the request body that carries the conversation is deliberately in-memory and "resets on reload (multi-turn context starts over)". So after any page reload — including every HMR reload during development — the transcript still shows the history while the model receives only the newest message, and it answers "there's no prior attempt in this conversation". The transcript is persisted; it should be the source of truth.

- [ ] **Step 1:** Stop writing display markers into `ChatMessage.text`. Add `markers` (defaulted, so a stored conversation still parses) and keep `text` the model's own words, so the stored text is exactly what may go on the wire. `Message.tsx` already interleaves markers with the text runs for display; it should render from the two fields instead.
- [ ] **Step 2:** Rebuild the wire history from the conversation's messages when the in-memory body is absent — one per-protocol builder, the inverse of `appendAssistant`, faithful (text **and** attachments, since the API is stateless). Skip `role: "error"` messages: they are the app's words, not the model's, and no wire role matches them. Do not try to reconstruct tool rounds: they live inside the turn that made them. **And clear the entry whenever a run fails:** `finalize` writes the body only on success, so a turn that errored never entered it — and because the stale body is still present, a rebuild that only fires "when absent" would never run, leaving the model permanently blind to the turn that failed. Deleting it on failure makes the next turn rebuild from the transcript, which does carry the failed turn's user message (the `error` row itself is skipped). This is the reported symptom: a network error, then the model acts as if the earlier exchange never happened.
- [ ] **Step 3:** Verify — a throwaway script that rebuilds each protocol's body from a conversation and asserts the wire shape; then the live proof: send a turn, reload the page, send a follow-up, and assert from a mock's request log that the second turn's body carries the first turn's user message and answer.
- [ ] **Step 4:** Commit — `fix: rebuild conversation history after a reload`.

---

### Task 43: Foldable Settings sections

**Files:** modify `ui/Settings.tsx`.

**Why:** Settings is one long scroll of sections, so someone who came to change one thing sees all of it at once. Folding each section makes the page scannable, and it is the same disclosure the transcript already uses for a model's thinking.

- [ ] **Step 1:** One small collapsible wrapper inside the file: a `<details>` whose `<summary>` carries the section's existing `<h3>` styling, plus the `cursor-pointer select-none` the thinking block uses, with the section's content as its children. **Open by default** — a fold that starts closed hides content the user never chose to hide.
- [ ] **Step 2:** Wrap every section (the ones headed by the `text-xs uppercase tracking-widest` `<h3>`s), leaving the page's own heading alone.
- [ ] **Step 3:** Verify — gates, then a browser check that every section shows its content on load and collapses and reopens on click (the thinking block is the reference for the interaction).
- [ ] **Step 4:** Commit — `feat(ui): foldable Settings sections`.

---

## Out of scope (this plan)

- General tool execution beyond the two client tools this plan ships (`fetch_url`, `web_search`).
- Auth beyond a bearer key or `x-api-key`.
