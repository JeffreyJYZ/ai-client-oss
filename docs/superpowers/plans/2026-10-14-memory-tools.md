# Memory as Tools (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memory becomes agent-driven **tools** with agent-chosen ids — create, update, remove, revert, list — with soft deletion and a recently-deleted view so nothing is destroyed, and revert covering both an edit and a removal.

**Architecture:** One pure module owns the note store and a **single mutator**; the tools and the legacy `<memory>` tag both go through it, so the only difference between them is who names the id. Storage is additive (the legacy array stays and keeps being written), and the first real migration seeds notes from it — guarded by `dataVersion`.

**Tech Stack:** TypeScript, React 19, Effect, zod (the Settings schema), `bun:test`. Rust untouched.

**Spec:** `docs/superpowers/specs/2026-10-14-memory-tools-design.md`
**Depends on:** P1 (`app.memory` is a built-in area; the count of areas goes from nine to ten).

## Global Constraints

- **No new dependency.** Inside `web/src`: no `async`/`await`/`throw`/`try`/`catch`/`new Promise` (GritQL plugins); test files are exempt.
- Never `mock.module` a project module — inject through an existing seam.
- `cd web && bun run verify` is the gate; `cargo check --all-targets` stays clean.
- **A refusal is a result, never a fault.** No memory error may defect a turn.
- **The prompt stays byte-identical when there are no memories** — an existing property, deliberately preserved.
- **`memoriesEnabled` off means neither injection nor memory tools registered/announced.**
- The legacy `Settings.memories` array **stays and keeps being written**; the migration adds, it never rewrites.
- Markdown: one line per bullet, never hard-wrapped. Biome: tabs, width 4.
- Commits: `git add` a new file first, then `git commit --only <paths>`; conventional; **no measured number in a message**; `rg` scoped, never `grep`.

## Review Focus

Each line gets its test in the task named, because the spec implies the behaviour and no single task's tests cover it by default.

1. **A refusal that defects the turn** — a tool that throws, and a plain refusal, must both leave the turn alive with a readable outcome. *(T3)*
2. **A marker truncating a message** — a complete block mid-prose, a reply merely quoting a partial marker, a partial tag at end-of-stream, an unterminated block. *(T4)*
3. **A migration that runs twice, or rewrites the legacy array** — must be one-shot and additive, with the legacy array untouched. *(T2)*
4. **A path to purge from a tool** — there must be none; only the UI may purge. *(T5)*
5. **The two writers disagreeing** — a tag-created memory and a tool-created one must be indistinguishable afterwards. *(T4 — not T1)*: the tag path (`lib/memory.ts`'s `mergeMemories`) only routes through T1's single mutator in T4, so a test placed in T1 called one function twice and **could not fail**. It belongs where the second writer exists.

## File Structure

- `web/src/lib/memoryNotes.ts` *(new)* — the pure note store: shapes, the id allowlist, **one mutator**, and the five operations, each returning a result rather than throwing.
- `web/src/lib/memory.ts` *(modify)* — the existing tag path and prompt; the prompt grows the rules, and the tag path routes through the single mutator.
- `web/src/lib/db/types.ts` *(modify)* — the additive `memoryNotes` field and the version bump.
- `web/src/lib/db/migrate.ts` *(modify)* — the first real migration.
- `web/src/lib/plugins/builtin/memory.ts` *(new)* — the `app.memory` area: registers the five tools (only while memories are enabled) and the settings section.
- `web/src/ui/memory/MemorySection.tsx` *(new)* + `web/src/ui/Settings.tsx` *(modify)* — the UI moves out of the inline block into a registered section.
- `web/src/state/chat.ts` *(modify)* — the injection reads the new store.

---

### Task 1: The note store and its mutator (pure)

**Files:**
- Create: `web/src/lib/memoryNotes.ts`, `web/src/lib/memoryNotes.test.ts`

**Interfaces:**
- Produces: `MEMORY_ID_PATTERN: RegExp`; `interface MemoryEntry { id: string; content: string; updatedAt: number; deletedAt?: number; history: readonly { content: string; at: number }[] }` (renamed from this plan's earlier `MemoryNote`: `db/types.ts` already exports that name for the legacy `{id, text, createdAt, source}` shape, which stays); `type MemoryResult = { ok: true; notes: readonly MemoryEntry[] } | { ok: false; message: string }`; `addMemory(notes, id, content, now): MemoryResult`, `updateMemory(...)`, `removeMemory(...)`, `revertMemory(...)`, `listMemories(notes, includeDeleted?)`, and the bounds constants (`MEMORY_HISTORY_DEPTH`, `MEMORY_DELETED_CAP`).

- [ ] **Step 1: Write the failing tests**

```ts
test("an id must match the allowlist, and a bad one is refused with a message", …);
test("adding a taken id is refused with the id in the message", …);
test("remove is soft: the entry stays, with deletedAt set", …);
test("revert undoes a removal, and undoes an edit", …);
test("revert with empty history is a refusal, not a no-op", …);
test("history and the deleted list are bounded", …);  // assert the surviving contents by name and the evicted id: length alone passes if the NEWEST were kept
test("the input store is unchanged by every operation", …);  // immutability: read the return value only and an in-place mutation still passes
```

- [ ] **Step 2: Run them and watch them fail** — `cd web && bun test src/lib/memoryNotes.test.ts`.

- [ ] **Step 3: Implement**

Pure functions over an immutable list: one private mutator that every operation goes through (that is what makes Review Focus 5 true), returning `{ ok, notes }` or `{ ok: false, message }` — **never throwing**. The id rule is its own anchored allowlist (lowercase, `[a-z0-9][a-z0-9._-]{0,63}`): it guards a different thing from the plugin id rule and from P1's area rule, so it gets its own schema rather than a shared one. History pushes the previous content and drops the oldest past the bound; the deleted list drops the oldest past its own cap.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit** — `git add` both files, then `git commit --only` them: `feat(memory): the note store and its one mutator`.

---

### Task 2: Persistence and the first migration

**Files:**
- Modify: `web/src/lib/db/types.ts`, `web/src/lib/db/migrate.ts`
- Test: `web/src/lib/db/migrate.test.ts` (or the existing migration test file)

**Interfaces:**
- Consumes: T1's `MemoryEntry`.
- Produces: `Settings.memoryNotes: MemoryNote[]` (optional, defaulting to `[]`) and one entry in `migrations` whose `to` is the bumped `DATA_VERSION`.

- [ ] **Step 1: Write the failing tests** — an absent `memoryNotes` field means no notes (not a failure); a legacy-only blob migrates **once** into unique slug ids; running the migration again changes nothing; the legacy array is **byte-identical** afterwards; and the **frozen 0.2.3 fixture still parses** the new blob (the tolerance guarantee, using the fixtures the data-safety phase froze).

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the schema field (optional, so nothing needs migrating on its own account) and the migration: for each legacy note, a slug id derived from content, deduped with a numeric suffix; `updatedAt` = **the legacy note's own `createdAt`** (legacy notes carry one, so no age is invented) — **not** a clock read, because `migrate.ts` documents `run` as a pure, idempotent transform and `Date.now()` would make two runs differ; empty history; the legacy array untouched.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 3: The five tools, registered by the `app.memory` area

**Files:**
- Create: `web/src/lib/plugins/builtin/memory.ts`, its test
- Modify: `web/src/lib/plugins/builtin/index.ts` (the aggregator) and P1's area table only as P1's own rules require

**Interfaces:**
- Consumes: T1's operations, T2's field, the settings seam.
- Produces: five registered tools — `memory_add`, `memory_update`, `memory_remove`, `memory_revert`, `memory_list` — each with a declaration (name, description, parameters schema) and an `execute` returning an `Effect` **outcome**, never a fault.

- [ ] **Step 1: Write the failing tests** — all five are in the registry with their declarations; a refusal comes back as a **failed outcome with a message** (and a tool made to throw still leaves the turn alive); and with `memoriesEnabled` off **none of the five is registered** (which is what keeps them off the wire, since the registry is what T24a announces).

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — register through `host.tools` (the public API, as every built-in does), each `execute` calling the single mutator and translating `{ ok: false }` into a failed outcome whose result text is the message.

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 4: The prompt, and the tag as the fallback

**Files:**
- Modify: `web/src/lib/memory.ts`, `web/src/state/chat.ts`
- Test: `web/src/lib/memory.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: T1/T2's store; the existing `memoryPrompt` and `extractMemories`.
- Produces: a grown `memoryPrompt(notes)` and a tag path that writes through T1's mutator.

- [ ] **Step 1: Write the failing tests** — the prompt is **byte-identical** when there are no memories (the preserved property) and carries `id — content` plus the four rules when there are (update in place; never record tool availability; never record per-session transient state; a newer memory supersedes a stale one); **Review Focus 5** — a tag-created note and a tool-created note are indistinguishable afterwards (deep-equal modulo the generated vs chosen id), testable *here* because the tag path now routes through T1's mutator and **not testable in T1**, where both sides were one function; the tag path creates a note **and** mirrors into the legacy array; and the **truncation suite** of Review Focus 2 — a complete block mid-prose keeps everything before and after, a reply merely *quoting* a partial marker renders whole, a stream ending in a partial tag neither chops the text nor loses a complete block, and an **unterminated** block is dropped with a log line rather than half-stored.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** — the rules and the id lines; the tag path through the single mutator; `state/chat.ts` injecting from the new store (still nothing injected when memory is off, or when there is nothing to inject).

- [ ] **Step 4: Run them and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 5: The UI as a registered section

**Files:**
- Create: `web/src/ui/memory/MemorySection.tsx` + a pure view-model test
- Modify: `web/src/ui/Settings.tsx` (the inline block goes), `web/src/lib/plugins/builtin/memory.ts` (registers the section), **`web/src/lib/plugins/builtin/settings.ts`** (the registration must **move**, not be added — T5 is not "make it a registered section": P1 already registered `MemorySection` as `settings.section.memory`, order 70, under the **`app.settings`** area. The section has to be owned by `app.memory` so toggling that area removes it, so the entry leaves `settings.ts` (whose doc comment counts "nine `settings.sections` entries" and becomes eight) and appears in `memory.ts`. Leaving both is not a double render: the registry refuses a duplicate id first-wins and logs a fault, so the section would silently stay owned by `app.settings` — the move must therefore **remove** the old entry, not just add the new one.)

**Interfaces:**
- Produces: `memoryRows(notes, now): readonly MemoryRow[]` — a pure view-model with the live list (each carrying its **id**), the recently-deleted list, and for each a `canRevert` flag with a `reason` when it cannot.

- [ ] **Step 1: Write the failing tests** — a row carries its id; a soft-deleted note appears in the deleted list and not the live one; `canRevert` is false with a reason when history is empty; and **no registered tool can purge** (the safety asymmetry is a test, not a comment).

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** the view-model and the section (edit, remove, revert, restore, and a purge control that only this UI reaches), registered by the `app.memory` area so P1 can toggle the whole thing; `Settings.tsx` loses the inline block.

- [ ] **Step 4: Run them and watch them pass**, then a browser proof on the production build: add → edit → revert → remove → restore → purge, with a live page sentinel and `agent-browser errors` clean.

- [ ] **Step 5: Commit.**

---

### Task 6: End to end, through a real tool turn

**Files:**
- Test: `web/src/state/chat.test.ts` (the scripted-endpoint pattern T19/T24a established)
- Report: the workspace's `task-6-report.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test** — against a scripted model endpoint: a tool call to `memory_add` creates the note; a second `memory_add` with the same id returns the refusal to the model **and the turn survives**; `memory_remove` soft-deletes it; `memory_revert` restores it; and with memories disabled **no memory tool appears in the outgoing body's `tools`**.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Make it pass** (no production change expected — this is the integration the design predicts).

- [ ] **Step 4: Prove the disabled case in a browser** alongside the enabled one, and record what a real provider would still have to confirm.

- [ ] **Step 5: Commit** the test; state plainly what could not be proven from here.

---

## Self-Review

**Spec coverage:** five tools → T3; agent-chosen ids + a readable refusal → T1/T3; soft delete + recently-deleted view → T1/T2/T5; revert for both edits and removals → T1/T5; the single mutator (and thus the two writers agreeing) → T1; additive storage + the first migration → T2; prompt ids + rules, tag as fallback → T4; marker detection never truncating → T4; `app.memory` as a toggleable area → T3/T5; agent-cannot-purge → T5; end-to-end on the wire → T6.

**Step scan:** every step names a file, a command, or an exact assertion; no step carries a body the signature and test already determine.

**Type consistency:** `MemoryEntry`, `MemoryResult` and the five operation names are defined once in T1 and used verbatim in T2–T6; `MEMORY_ID_PATTERN` is T1's alone; the tool names in T3 match those in T6's assertions. (`db/types.ts` keeps its own legacy `MemoryNote` for `{id, text, createdAt, source}` — a different type, deliberately not the same name.)

**Review Focus:** all five lines have their test in the named task (1 → T3, 2 → T4, 3 → T2, 4 → T5, 5 → T4 — moved off T1, which could not make it fail).

**Proportion:** six tasks, one test cycle each; the spec is the argument, this is the decision list.

## Out of scope (stated so it is not mistaken for an omission)

A similarity/dedupe engine; embeddings or vector recall; shared or multi-user memory; a `scope` field with auto-purge (ruled out with reasons in the spec); P3's auto-titler, which is its own spec.
