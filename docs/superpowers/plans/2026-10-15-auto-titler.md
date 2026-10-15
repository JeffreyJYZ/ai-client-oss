# Auto-titler (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name a conversation from its first user query using a configurable, free-by-default model — once — without ever overwriting a title the user chose.

**Architecture:** A pure model-resolution rule and a pure prompt/sanitizer own every decision; the `app.titler` area fires one request after the first user message is appended, through the transport the chat already uses, and writes the result only while the title is still derived. The trigger is `messages.length === 1` **and** a `titleSource` that is neither `"model"` nor `"user"` — both halves, re-checked at write time.

**Tech Stack:** TypeScript, React 19, Effect, zod, `bun:test`. Rust untouched.

**Spec:** `docs/superpowers/specs/2026-10-14-auto-titler-design.md` — the authority; the plan argues from it, and where they differ the spec wins.

## Global Constraints

- **No new dependency.** Inside `web/src` source files: no `async`/`await`/`throw`/`try`/`catch`/`new Promise` (GritQL plugins; test files exempt).
- Never `mock.module` a project module — drive the real one or inject a seam.
- `cd web && bun run verify` is the gate. Biome: tabs, width 4, **zero warnings you introduce** (warnings do not fail the gate — read the count).
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

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the rule exactly as the spec's goal 3 orders it (opencode lane → OpenRouter → off), requiring a **non-empty key** and consulting the provider's **cached model list** before trusting a hardcoded free id; the prompt (title only, short word count as a named constant); the sanitizer (`cleanTitle`: strip a leading `Title:` label, wrapping quotes, markdown emphasis and a trailing newline, then cap at the length constant).

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): a model rule that degrades to off, and a title worth showing`.

---

### Task 3: The request

**Files:**
- Modify: `web/src/lib/titler.ts` (+ its test)

**Interfaces:**
- Consumes: T2's `TITLER_PROMPT`, `cleanTitle`; `sendStream` (`lib/providers/send.ts`) and the transport/header helpers the chat path uses; a resolved provider **value** and a conversation id.
- Produces: `titleFor(input: { provider: ResolvedProvider; conversationId: string; firstMessage: string }): Effect.Effect<string | undefined>` — an effect that **requires nothing** (`R = never`), returns the sanitized title, and fails only in ways the caller logs.

- [ ] **Step 1: Write the failing tests**

```ts
test("a text chunk becomes the title", …);
test("reasoning chunks are ignored", …);                       // Review Focus 3
test("several text chunks are folded in order", …);
test("a stream that yields no text returns undefined rather than an empty title", …);
test("the request carries no tools and the conversation's own session id", …);
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — reuse `sendStream` (which already returns the parsed chunk stream) with the titler's own message, `fetchTool: false` and no `tools`. Fold **only** `kind === "text"` chunks — a reasoning model streams its scratchpad first and folding it would put the model's thinking in the sidebar. Sanitize, then return; do **not** reuse `testModel`, which deliberately never reads a body. Keep the effect's `R` empty: the provider arrives as a value (T4 supplies it).

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): one request, text chunks only, sanitized`.

---

### Task 4: The `app.titler` area

**Files:**
- Create: `web/src/lib/plugins/builtin/titler.ts` (+ its test)
- Modify: `web/src/lib/plugins/builtinIdentity.ts`, `web/src/lib/plugins/areas.ts`, `web/src/ui/plugins/BuiltinsArea.tsx` (its contribution catalog), `web/src/lib/plugins/builtin/index.ts` if the aggregator needs it

**Interfaces:**
- Consumes: T1's signal and `titleSource`, T2's rule, T3's `titleFor`, `resolveProviderSync` (`lib/plugins/providers.ts`), `host.run` + `Effect.scoped`.
- Produces: the **13th** built-in area, `app.titler` (toggleable, `locked: false`, truthful one-sentence description), whose registrar owns a scope-limited run that titles each conversation once.

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
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the trigger as the spec defines it (`messages.length === 1` before this send **and** `titleSource` not `"model"`/`"user"`), an in-flight set keyed by conversation id (per page — say so in a comment rather than implying a lock), and the write-back that **re-checks** `titleSource` and refuses `"user"`/`"model"`.
  **The run mechanism is the part with no room for invention:** resolve the provider **synchronously** with `resolveProviderSync`, pass the resolved **value** into `titleFor` (whose effect requires nothing), and own it with `host.run` + `Effect.scoped` inside the area's scope — `host.run`'s parameter is `R = never` by type and it runs on the empty-context runtime, so it cannot run an effect needing `HostServices`; `runtime.runFork` carries context but is not scope-owned and leaks. A comment states that, since the two obvious alternatives both look correct.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `feat(titler): the app.titler area owns one title per conversation`.

---

### Task 5: The setting, the hint, and end to end

**Files:**
- Create: `web/src/ui/titler/TitlerSection.tsx` (+ a pure view-model test if the row shows state)
- Modify: `web/src/ui/Settings.tsx` (the inline sections list), `web/src/lib/plugins/builtin/settings.ts` (registration), `web/src/lib/plugins/builtin/titler.ts` (register the section)

**Interfaces:**
- Consumes: T2's rule (for the resolved/unresolved answer), `Settings.titler`, the area's state.
- Produces: the settings section (a model picker for the titler plus a one-line hint) and the end-to-end proof.

- [ ] **Step 1: Write the failing tests** — the row shows the resolved model when there is one; it says **which** no-op it is when there is not (no provider at all vs a resolved-but-failing one — the distinction the spec makes); and choosing a model writes `Settings.titler`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** the section, register it under `app.titler` (the section must be **owned by the area**, so the registration goes in `titler.ts` and **not** into `builtin/settings.ts`'s list — a duplicate id is refused first-wins with a logged fault, which would silently leave the wrong owner), and wire the hint.

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

