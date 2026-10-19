# Auto-titler (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name a conversation from its first user query using a configurable, free-by-default model — once — without ever overwriting a title the user chose.

**Architecture:** A pure model-resolution rule and a pure prompt/sanitizer own every decision; the `app.titler` area fires one request after the first user message is appended, through the transport the chat already uses, and writes the result only while the title is still derived. The trigger is `messages.length === 1` **and** a `titleSource` that is neither `"model"` nor `"user"` — both halves, re-checked at write time.

**Tech Stack:** TypeScript, React 19, Effect, zod, `bun:test`. Rust untouched.

**Spec:** `docs/superpowers/specs/2026-10-14-auto-titler-design.md` — the authority; the plan argues from it, and where they differ the spec wins.

**Amended 2026-10-19 after a plan review and two read-only recon passes.** Folded into the tasks below, each with its reason where it lands: T1 gained a **Task 1b** (the missing `titleSource: "model"` writer — T1 shipped the storage and the `"user"` half only); T3's announced input type `ResolvedProvider` **does not exist in this tree** (the real value is `ProviderEntry`) and its input was missing the credentials a `Provider` does not carry; T4's injected seams, its exported registrar name and the test pins that go red (the toggleable-area count, the `settings.sections` order, and the `BuiltinsArea.tsx` catalog in **both** T4 and T5) are now named; T5 dropped two files that have nothing to change (`builtin/settings.ts`, and `ui/Settings.tsx`, which renders a slot, not an inline list) and gained the status record that makes its "resolved-but-failing" assertion implementable.

## Global Constraints

- **No new dependency.** Inside `web/src` source files: no `async`/`await`/`throw`/`try`/`catch`/`new Promise` (GritQL plugins; test files exempt).
- Never `mock.module` a project module — drive the real one or inject a seam.
- `cd web && bun run verify` is the gate. Biome: the repo's own `biome.jsonc` (tabs; **no formatter width is configured**, so Biome's default applies — never reformat to a personal width), **zero warnings you introduce** (warnings do not fail the gate — read the count).
- `Conversation.titleSource` must be `z.enum([...]).optional().catch("derived")`. A bare enum makes `conversationSchema.safeParse` fail and **discards the whole conversation**.
- `renameConversation` writes `titleSource: "user"` **together with** the title; a model title is refused when the source is `"user"` or `"model"`.
- The titler never blocks, fails or delays a turn: a failure is logged and the derived title stays.
- The area is on by default and is an **honest no-op** when no model resolves — a provider with an **empty key** counts as unresolved, not as a request that fails.
- Commit hygiene: `git add` a new file first, then `git commit --only <paths>`; Conventional Commits; **no measured number in a commit message**; `rg`, scoped — never `grep`.
- Markdown: one line per bullet, never hard-wrapped.

## Review Focus

The spec implies these; no task's tests cover them by default, so each gets its test in the task named.

1. **A model title overwriting a rename** — the write re-checks `titleSource` and refuses `"user"`/`"model"`, and a rename that lands *while* a title is in flight still wins. *(T4)*
2. **A second send re-titling, or an old conversation being titled** — the guard is first-message **and** source; either half alone re-fires after a failed attempt or titles a hydrated conversation. *(T1's signal, T4's guard)*
3. **A reasoning model's scratchpad ending up in the sidebar** — only chunks of `kind === "text"` are folded. *(T3)*
4. **A resolved-but-unusable model failing silently** (no key, a dead free id, the browser preflight refusal) — the rule degrades to *off* and the hint says which. *(T2)*
5. **Decoration surviving into the title** (a `Title:` prefix, quotes, markdown, a trailing newline) — the sanitizer strips it before the length cap. *(T2)*

---

### Task 1: The storage field, the rename write, and the first-message signal

**Files:**
- Modify: `web/src/lib/db/types.ts` (the conversation schema + `Settings`), `web/src/state/chat.ts`
- Test: `web/src/lib/db/types.test.ts` or the existing conversation-store suite, `web/src/state/chat.test.ts`

**Interfaces:**
- Produces: `Conversation.titleSource?: "derived" | "model" | "user"` (absent = `"derived"`); `renameConversation(id, title)` also sets `titleSource: "user"`; and a **first-message signal** the area can subscribe to — one that fires **after** the user message is appended and carries the conversation id and the message text.

- [ ] **Step 1: Write the failing tests**

```ts
test("a conversation with no titleSource reads as derived", …);   // absent → optional, no migration
test("a titleSource outside the enum degrades instead of dropping the conversation", …);  // {"titleSource":"weird"} still parses
test("renameConversation marks the title user-authored", …);      // after a rename, titleSource === "user"
test("the first-message signal fires once, after the message is stored", …);  // the payload carries the text; the store already holds 1 message
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the schema field (`.catch("derived")`), the second write in `renameConversation`, and the signal. `turn-start` fires *before* the append and carries no text, so the signal is either a new event published after the append or the store snapshot read at the same point; **say which in a comment**, and keep it synchronous with the send path.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `git add` the new test if any, then `git commit --only <paths>`: `feat(titler): a title records who wrote it, and the first message is observable`.

---

### Task 1b: The `"model"` writer (added after the plan review)

**Why it exists:** Task 1 shipped the storage field and the `"user"` writer, but **nothing in the tree ever wrote `titleSource: "model"`** — so T4's write-back had no function to call and the never-overwrite guarantee had only half its guard.

**Files:**
- Modify: `web/src/state/chat.ts` (+ `web/src/state/chat.test.ts`)

**Interfaces:**
- Produces: `titleIfDerived(id: string, title: string): boolean` — writes `{ title, titleSource: "model" }` **only if** the conversation still exists **and** its `titleSource` is not `"model"`/`"user"`; one `updateConversation` + one `refresh` + one persist, the read-check-write synchronous; returns whether it wrote (`false` is a normal refusal, not an error). **The existence check is what covers a conversation deleted while a title was in flight** — the area's scope belongs to the area, not to a conversation, so delete cannot close it.

- [ ] **Step 1: Write the failing tests** — writes when the source is absent/`"derived"`; refuses when `"user"`; refuses when `"model"`; refuses silently when the conversation does not exist; and **the race**: `titleIfDerived` after a `renameConversation` on the same id leaves the user's title and `"user"` source intact.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** — `renameConversation` stays the `"user"` writer; these two are the only writers of `titleSource` in the tree.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit** — `feat(titler): a model title is refused once a human or a model owns the name`.

---

### Task 2: The pure rule, the prompt, and the sanitizer

**Files:**
- Create: `web/src/lib/titler.ts`, `web/src/lib/titler.test.ts`
- Modify: `web/src/lib/db/types.ts` (`Settings.titler`)

**Interfaces:**
- Consumes: `Settings.providers` (each with `baseUrl`, `apiKey`, `models`), `isOpencodeHost` from `lib/providers/presets.ts`.
- Produces: `resolveTitlerModel(settings, isDesktop): { providerId: string; model: string } | undefined`; `TITLER_PROMPT: string`; `cleanTitle(raw: string): string`; `TITLER_MAX_TITLE_LENGTH: number`; `Settings.titler?: { providerId?: string; model?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an opencode provider with a key on desktop resolves to its free lane", …);
test("an opencode provider with an EMPTY key resolves to nothing", …);            // Review Focus 4
test("the opencode lane is not chosen on web, where its endpoint refuses the preflight", …);
test("no opencode provider falls back to an OpenRouter free model", …);
test("an explicit Settings.titler override wins over the rule", …);
test("a free id the provider's cached model list no longer carries falls through", …);
test("cleaning strips a Title: prefix, quotes, markdown and a trailing newline", …); // Review Focus 5
test("cleaning caps the length", …);
```

**Test-strength notes (added after the plan review):** test 3 must assert the **outcome** (the rule returns `undefined`, or the OpenRouter fallback) — `expect(model).not.toBe(opencodeLane)` passes while the rule returns garbage. Tests 1 and 6 only pin the cached-model-list rule together: test 1's fixture must carry the free id in the provider's cached `models`, and test 6 must be test 1 with that id removed.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the rule exactly as the spec's goal 3 orders it (opencode lane → OpenRouter → off), requiring a **non-empty key** and reading the free id **out of the provider's own cached model list** rather than hardcoding one. **Measured 2026-10-19: `step-5-preview-free` is in *neither* lane's live list** (`https://opencode.ai/zen/v1/models` and `https://opencode.ai/inference/go/v1/models`) — the free ids there are `beam-free`, `longcat-2.5-preview-free`, `deepseek-v4.1-flash-free`, …. So the free id is *found* in the list (an id marked free), and an **empty list means "not carried"**: the lane degrades instead of sending a request that cannot succeed, and the "no model" state is one T5's hint must name. The prompt (title only, short word count as a named constant); the sanitizer (`cleanTitle`: strip a leading `Title:` label, wrapping quotes, markdown emphasis and a trailing newline, then cap at the length constant).

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): a model rule that degrades to off, and a title worth showing`.

---

### Task 3: The request

**Files:**
- Modify: `web/src/lib/titler.ts` (+ its test)

**Interfaces:**
- Consumes: T2's `TITLER_PROMPT`, `cleanTitle`; the provider **value** (`ProviderEntry` — what `resolveProviderSync` resolves; **`ResolvedProvider` does not exist in this tree**) *and* the credentials a `Provider` does not carry (its `ProviderConfig`, `baseUrl`, `apiKey`, `model`), plus a conversation id.
- Produces: `titleFor(input: { provider: ProviderEntry; baseUrl: string; apiKey: string; model: string; conversationId: string; firstMessage: string }): Effect.Effect<string | undefined, string>` — `R = never` (the provider and its credentials arrive as **values**, so nothing needs `HostServices`), returning the sanitized title, or `undefined` when the stream carried no text *or cleaned to nothing*; a failure is a **typed `string` cause the caller logs**, never a defect. A bare `Effect.Effect<string | undefined>` would claim `E = never`, which is false. **A `ProviderConfig` is *not* a parameter** — `provider.send(ctx)` reads only `SendCtx`, so passing a config would be an excess-property error on the literal (landed: `0fbdce5`).

- [ ] **Step 1: Write the failing tests**

```ts
test("a text chunk becomes the title", …);
test("reasoning chunks are ignored", …);                       // Review Focus 3
test("several text chunks are folded in order", …);
test("a stream that yields no text returns undefined rather than an empty title", …);
test("the request carries no tools and the conversation's own session id", …);
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — go through `provider.send(ctx)` (the function the **chat path** calls: the provider builds the body, calls `sendStream`, and the caller folds chunks. `testModel` does *not* call it — it goes to `provider.headers`/`provider.buildRequest`/`chatTransport` directly), with the titler's own message, `fetchTool: false`, **no** `tools`/`search`, and the **conversation's own** id as the session id. Fold **only** `kind === "text"` chunks — a reasoning model streams its scratchpad first and folding it would put the model's thinking in the sidebar. Sanitize, then return. **The test seam is a fake `Provider` whose `send(ctx)` returns `Stream.fromIterable(chunks)`** (the pattern `providers.test.ts` / `chat.test.ts` already use) — the only reading under which the "no tools, the conversation's own session id" assertion can capture anything; a raw `sendStream` call hides `ctx` and forces a global `fetch` stub. Do **not** reuse `testModel`, which deliberately never reads a body. Keep the effect's `R` empty: the provider arrives as a value (T4 supplies it).

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): one request, text chunks only, sanitized`.

---

### Task 4: The `app.titler` area

**Files:**
- Create: `web/src/lib/plugins/builtin/titler.ts` (+ its test), `web/src/lib/titlerStatus.ts` (+ its test)
- Modify: `web/src/lib/plugins/builtinIdentity.ts`, `web/src/lib/plugins/areas.ts`, `web/src/ui/plugins/BuiltinsArea.tsx` (its catalog — `[]` here), `web/src/lib/plugins/memory.test.ts` (the toggleable-area count, 10 → 11)
- **No change** to `web/src/lib/plugins/builtin/index.ts` — it walks `BUILTIN_AREAS`, so there is no aggregator to add to (the earlier "if the aggregator needs it" was a phantom).

**Interfaces:**
- Consumes: T1's `subscribeUserMessage` signal and `titleSource`, T1b's `titleIfDerived`, T2's rule and `Settings.titler`, T3's `titleFor`, `resolveProviderSync` + its `ProviderEntry` (`lib/plugins/providers.ts`), `host.run` + `Effect.scoped`.
- Produces: the **13th** built-in area, `app.titler`, whose registrar owns scope-limited runs that title each conversation once. Concretely: the export must be named `/^register.+Builtins$/` (`areas.test.ts` counts exports matching that); the identity entry uses **`label`**, not `title`, and must satisfy the identity shape test (one sentence, `<240` chars, one terminal period, **no interior `.`**); `areas.ts`'s registrar `Record<BuiltinId, …>` is exhaustive, so a missing entry is a `tsc` error; `BuiltinsArea.tsx`'s `Readonly<Record<BuiltinId, …>>` catalog gains `[]` — the area registers no contribution of its own yet, and `BuiltinsArea.test.ts` requires the catalog to equal what actually registers.
- **The seams, because four of its tests cannot be written without them** (the memory area's injected `MemorySettingsSource` is the precedent): the registrar takes an injected `deps` — `{ titleFor, readConversation, writeTitle, recordOutcome }` — defaulting to the real ones, so a test can hold a title open (`Deferred`), land a rename mid-flight, and **count requests** ("with the area off, no request is made at all" needs a counter, not merely an unchanged title). `recordOutcome` writes `titlerStatus.ts`, which T5's hint reads.

- [ ] **Step 1: Write the failing tests**

```ts
test("the first user message titles the conversation", …);            // title + titleSource === "model"
test("a second send does not re-title", …);                           // Review Focus 2
test("a hydrated conversation with messages is never titled", …);      // Review Focus 2
test("a rename wins: a title that lands while one is in flight is not overwritten", …);  // Review Focus 1
test("a conversation the user renamed is never titled", …);            // titleSource === "user"
test("a failed title leaves the derived title and logs", …);           // the turn is unaffected
test("with the area off, no request is made at all", …);
test("the area closes its run when toggled off", …);                   // the scope owns the fibre
test("with no model resolved, no request is made at all", …);          // the honest no-op, counted
test("an attachments-only first message (empty text) is skipped", …);
test("a conversation deleted while a title is in flight writes nothing", …);  // T1b's existence re-check
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the trigger as the spec defines it (`messages.length === 1` before this send **and** `titleSource` not `"model"`/`"user"`), an in-flight set keyed by conversation id (per page — say so in a comment rather than implying a lock), and the write-back that **re-checks** `titleSource` and refuses `"user"`/`"model"`.
  **The run mechanism is the part with no room for invention:** resolve the provider **synchronously** with `resolveProviderSync`, pass the resolved **value** into `titleFor` (whose effect requires nothing), and own it with `host.run` + `Effect.scoped` inside the area's scope — `host.run`'s parameter is `R = never` by type and it runs on the empty-context runtime, so it cannot run an effect needing `HostServices`; `runtime.runFork` carries context but is not scope-owned and leaks. A comment states that, since the two obvious alternatives both look correct.
  **Two runs, not one, and the write goes through T1b:** the signal *subscription* is one scope-owned run (`host.run(Effect.scoped(Effect.acquireRelease(subscribe, (stop) => stop()).pipe(Effect.andThen(Effect.never))))` — the memory area's exact shape), and each title is a **second** `host.run` forked into the same scope from inside the subscriber, so toggling the area off interrupts the subscription *and* any title in flight. The write-back calls `titleIfDerived` (T1b), never a raw `updateConversation`: that function is what re-checks existence and the source in one synchronous step. A signal whose `text` is empty (attachments only) is skipped.
  **Catch the whole cause, not just the typed error:** `titleFor` declares a typed `string` failure, but a protocol whose `send` *throws synchronously* **defects** the effect instead (the chat path isolates that in `sendThrough`; `titleFor` does not — measured by T3's implementer). A defect must still be logged and recorded as the attempt's outcome, or a faulting provider looks like a titler that never ran.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): the app.titler area owns one title per conversation`.

---

### Task 5: The setting, the hint, and end to end

**Files:**
- Create: `web/src/ui/titler/TitlerSection.tsx`, `web/src/ui/titler/titlerRows.ts` (+ its pure test — every other section in this repo has one)
- Modify: `web/src/lib/plugins/builtin/titler.ts` (register the section under `app.titler`), `web/src/ui/plugins/BuiltinsArea.tsx` (the catalog entry `[]` → `["settings.section.titler"]`), `web/src/state/builtins.test.ts` (the ordered `settings.sections` pin)
- **No change** to `web/src/lib/plugins/builtin/settings.ts` (the section is owned by the area — registering it there is exactly the duplicate-id, first-wins trap Step 3 warns about) or to `web/src/ui/Settings.tsx` (it renders `<Slot id="settings.sections" />`; there is no inline sections list)

**Interfaces:**
- Consumes: T2's rule (the resolved/unresolved answer), `Settings.titler`, and **T4's `titlerStatus.ts`** — without that record the "resolved-but-failing" case is not knowable in the UI, because it is observable only *after* a request has failed.
- Produces: the section `settings.section.titler`, **owned by `app.titler`** (so switching the area off takes the row it explains with it — an area's section is not rendered while the area is off), plus the end-to-end proof.

- [ ] **Step 1: Write the failing tests** (pure, in `titlerRows.ts`'s test, except the last) — the row shows the resolved model when there is one; it says **which** no-op it is when there is not (no provider at all vs one that resolved and then failed — the distinction the spec makes, read from `titlerStatus.ts`); and choosing a model writes `Settings.titler` (through the injectable settings seam `state/builtins.test.ts` already uses).

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** the section, register it under `app.titler` (the section must be **owned by the area**, so the registration goes in `titler.ts` and **not** into `builtin/settings.ts`'s list — a duplicate id is refused first-wins with a logged fault, which would silently leave the wrong owner), and wire the hint. **The hint has three states and each names its remedy:** a resolved model (which one, and that it may differ from the chat's provider); no model at all — where the remedy is the model picker's **Fetch models** (a provider whose cached list is empty carries no free id, by the rule's own design) or an explicit choice from the list; and resolved-but-failed (T4's `titlerStatus` record).

- [ ] **Step 4: End to end, then a browser proof.** A scripted turn titles a conversation; a failing title leaves the derived one; a renamed conversation is never titled; with the area off **no request** is made. Then on the **production bundle** (`bunx vite build && bunx vite preview`), in a private `agent-browser` session: send a first message, watch the sidebar title change, rename a conversation and confirm a later send does not overwrite it, toggle the area off and confirm no request is made, with `agent-browser errors` and the console clean. **Record what could not be proven from here** — a live model actually returning a usable title, and the paid-provider path.

- [ ] **Step 5: Commit** — `feat(titler): the setting, the honest hint, and the end-to-end proof`.

---

## Self-Review

**Spec coverage:** the trigger + guard → T1/T4; the free-by-default rule, overridable → T2; sanitization + the word cap → T2; the request and text-only folding → T3; the area + scope-limited run + write-back refusal → T4; the honest no-op vs resolved-but-failing → T2/T5; cost/rate stated → the spec, and the hint where a user can act on it (T5); privacy (a different provider) → the spec, surfaced by the picker (T5); cancellation on toggle-off → T4's scope ownership.

**Step scan:** every step names a file, a command, or an exact assertion. The one step that could have carried a body — the run mechanism — carries the *decision* instead (why `host.run` + a provider value, and why the two alternatives fail), because the signature and tests do not determine it.

**Type consistency:** `resolveTitlerModel`, `titleFor`, `cleanTitle`, `TITLER_PROMPT`, `TITLER_MAX_TITLE_LENGTH` and `titleSource` are defined once (T1/T2/T3) and used verbatim after; the area id is `app.titler` in the identity, the registrar and the catalog; the section id follows the existing `settings.section.*` shape.

**Review Focus:** all five lines have their test in the task named (1 → T4, 2 → T1/T4, 3 → T3, 4 → T2, 5 → T2).

**Proportion:** five tasks, one test cycle each; the decisions live in the spec, and this is the list of them.

## Out of scope (stated so it is not mistaken for an omission)

Re-titling existing conversations in bulk; titling on every message; per-conversation title prompts; emoji or tag classifiers; any titler UI beyond the settings row and its hint.

