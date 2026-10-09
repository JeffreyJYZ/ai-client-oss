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
- [ ] **Step 6:** Verify — tsc/biome/LS + a browser smoke against a **local mock SSE** that emits a reasoning event then an output event (throwaway `bun` server, not committed): the thinking appears in its own block, the answer separate, no squish.
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
- [ ] **Step 6:** Verify — tsc/biome/LS + a browser smoke: a Command Code provider with the toggle OFF sends no `tools` (no 400); an OpenAI provider with it ON sends the built-in.
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

## Out of scope (this plan)

- The Rust implementation of the Tauri storage adapter (stubbed in Task 4).
- Tool *execution* (declaring tools only), non-OpenAI-shaped SSE parsing, auth beyond a bearer key.
