# Memory as tools (P2) — design

Status: **written; awaiting review.** Rides on P1 (memory becomes a toggleable built-in area, `app.memory`). Sequenced after P1 by the requester.

## Purpose

Replace the in-band `<memory>` tag as the *primary* path with agent-driven **tools** carrying **agent-chosen ids**, so a memory can be created, updated, removed and reverted — with a safety net (a recently-deleted view) that makes destruction by a buggy or rogue agent impossible, and with **revert** undoing either a content change or a removal, the way opencode's message revert steps a conversation back.

## What exists today (facts, with the code that says so)

- `web/src/lib/memory.ts`: `MEMORY_TAG_OPEN`/`MEMORY_TAG_CLOSE`, `extractMemories` (pure, idempotent, **safe mid-stream** — the visible text is derived from the whole raw accumulation; as of P2's T4 a *partial* tag is **not** held back, because a partial tag is prose and must render whole — the behaviour that reverses the earlier chop — while a **complete** opening tag with no close is a malformed block and is dropped), `memoryPrompt(notes)` (returns `""` when there are no notes, so the request stays byte-identical, and carries at most the newest `MAX_MEMORY_NOTES` — the bound that actually governs the request), `MAX_MEMORY_NOTES`, `MAX_MEMORY_NOTE_LENGTH`.
- Memories **already carry ids** (`MemoryNote`; `nextMemoryId()` → `memory-<uuid>`) — but they are auto-generated and the model can neither edit nor remove one: the tag path is append-only.
- The Memories UI lives **inline in `ui/Settings.tsx`** (a master `memoriesEnabled` toggle, a list, add/remove), not as a registered settings section.
- **The tool path exists** (T10 + T24a): `host.tools.register` announces a tool on the wire for endpoints that have a function-tool mechanism, the turn loop executes it, the result is correlated back with no orphan, and a **faulting executor becomes a failed outcome rather than a defect**.
- `Settings.dataVersion` and `db/migrate.ts` exist and **`migrations` is empty** — this would be its first real use.

## Goals

1. **Five tools**, every one returning a **result**, never a fault — a memory error must not take a turn down.
2. **Agent-chosen ids**, validated by a schema, so a bad id is a readable refusal.
3. Removals are **soft**. Only the user purges.
4. **Revert** steps a memory back one change — an edit *or* a removal (the requester chose both).
5. **Additive** storage, plus the first real migration (legacy notes seeded with deduped slug ids).
6. The `<memory>` tag **stays**, as the documented fallback for endpoints that cannot be sent tool declarations.
7. The system prompt injects `id — content` lines, and a `memory_list` tool exists for recovery after a context reset.
8. Marker detection must **never truncate** a message (a real bug the requester suffered in another client).
9. Memory is a built-in **area** (`app.memory`), toggleable like any other built-in once P1 lands.

## Non-goals

A semantic dedupe/similarity engine; vector recall or embeddings (all live memories are injected); multi-user or shared memory; per-session auto-purge beyond the scopes below.

## Design

### Tools

| Tool | Behaviour |
|---|---|
| `memory_add(id, content)` | Creates. A taken id returns a **refusal result**: `id "<x>" already exists — use memory_update, or pick another`. |
| `memory_update(id, content)` | Replaces the content, pushing the previous content onto a bounded history. An unknown id is a refusal naming the id. |
| `memory_remove(id)` | **Soft** delete: stamps `deletedAt`, leaving the entry in place and revertable. |
| `memory_revert(id)` | Steps back the **most recent change** for that id, whether that was an edit or a removal. Empty history → a **readable refusal**, never a silent no-op. |
| `memory_list(includeDeleted?)` | The ids and contents; the recently-deleted too when asked, so a model that lost its context can recover an id. |

- **Ids** get their own allowlist schema (not the plugin rule and not P1's area rule — each guards a different thing): lowercase, `[a-z0-9][a-z0-9._-]{0,63}`, so an id is typable by hand and safe to log.
- **Every refusal is a result**, never a fault: the outcome's failure flag is set so the transcript shows a failed call, and the message carries the reason. The model must be able to read the refusal and correct itself; nothing may defect the turn.
- **One internal mutator** backs all five tools **and** the legacy tag path, so the only difference between them is who names the id. Two mutators would let the paths diverge, which is the failure the "still written" rule below exists to prevent.

### Storage (additive)

One new field, deliberately a single list rather than two:

```ts
// MemoryEntry, defined in lib/memoryNotes.ts. Deliberately NOT named `MemoryNote`:
// db/types.ts already exports `MemoryNote` for the legacy {id, text, createdAt, source}
// shape, which stays (the legacy array keeps being written).
memoryNotes: Array<{
  id: string;
  content: string;
  updatedAt: number;
  deletedAt?: number;               // present = soft-deleted; the UI filters on it
  history: Array<{ content: string; at: number }>;   // bounded, newest last
}>
```

- **Recently deleted is a view**, not a second store: the UI (and `memory_list(includeDeleted)`) filter on `deletedAt`.
- **Bounds:** history depth and the number of soft-deleted entries are both capped, so settings cannot grow without limit; the oldest beyond the cap are dropped (the *content* of a live memory is never dropped, only its older revisions). **The request is bounded separately and independently:** the prompt carries at most a fixed number of live notes (newest first, since a newer memory supersedes a stale one) and a note's content has a length cap enforced by the tools as a readable **refusal** — the tag path *truncates* instead, because a reply has nobody to hand a refusal to, and that asymmetry is deliberate and documented at both sites. The exact depths and caps are **named constants pinned in the plan**, not inline numbers here.
- The legacy `Settings.memories` array **stays and keeps being written** by the **tag path** (the documented fallback), so a 0.2.3 or 0.3.0 install opening this data still works — the tolerance property the data layer was built for, and the requester's standing requirement. **Ruling on the ambiguity a review surfaced:** entries created by a **tool** or by the **UI** are written to `memoryNotes` only and do **not** mirror into the legacy array. The legacy array is a *downgrade-tolerance mirror*, not a second store; mirroring every writer would mean two writers on a lossy, capped list, and an older app reading a stale-but-working list is the property being bought. Consequence, stated so it is not a surprise: after a downgrade, notes created through tools or the UI are not visible to the older build.

### The first real migration

`dataVersion` bumps by one; the migration seeds a `memoryNotes` entry for each legacy note: a **slug id derived from the content**, deduped with a numeric suffix on collision, `updatedAt` = **the legacy note's own `createdAt`** (not migration time: a legacy note carries one, so no age is invented, and a clock read would break `migrate.ts`'s documented purity), empty history. The legacy array is **left intact** — the migration adds, it does not rewrite — so a downgrade still reads what it wrote. Guarded by the version, so it runs exactly once.

### The prompt, and the tag fallback

`memoryPrompt` grows the rules that only experience teaches, all of them responses to real failures:

- **Update in place, never re-add a corrected fact** — the redundancy the consumer reported ("X is a gateway" and "X is NOT a gateway" coexisting) exists because the old path could only append. With ids, a correction is an update.
- **Never record tool availability** (tools change per turn, so the claim is stale the moment it is written) **or per-session transient state** (a glitch in one session is not a fact).
- **Recency supersedes:** a newer memory on the same subject wins; the UI shows when each was last changed.
- The injected `id — content` lines, so the model can reference an id without a call.
- Everything above only while `memoriesEnabled` is on, and **byte-identical when there are no memories** — the existing property, preserved deliberately.

The tag path remains **documented as the fallback** for endpoints with no function-tool mechanism. A complete block adds a memory with a **generated** id (`memory-<uuid>`) through the same single mutator, so the fallback and the tools cannot disagree about what memory is.

### UI

The Memories section **moves out of `Settings.tsx` into a registered section** (which is what makes it P1-toggleable as `app.memory`) and gains: the id next to each memory, an **edit** control, **remove**, a per-memory **revert**, a **Recently deleted** view with **restore**, and a **purge** that only the user can reach. The agent can soft-delete forever and never purge — that asymmetry is the safety net, and it is enforced by the absence of a purge tool, not by policy text.

## Invariants and the tests that pin them

1. **No refusal defects the turn.** A tool that throws, and a refusal, both leave the turn alive with a readable outcome.
2. **No marker truncates a message.** A complete block mid-prose keeps everything before and after it; a reply merely *quoting* a partial marker renders whole; a stream ending in a partial tag neither chops the text nor loses a complete block; an **unterminated** block is dropped with a log line, never half-stored.
3. **Revert is honest.** One step per call; empty history is a refusal with a message.
4. **The agent cannot destroy live content.** No tool reaches purge, and no tool can remove a live note **permanently** — the only removal a tool has is the soft, revertable one. A soft-deleted note is restorable within the recently-deleted cap — the cap evicts **oldest-first**, so restoration is bounded by that constant rather than unbounded, and the cap's existence is the only reason a tool can indirectly age a deleted note out.
5. **The migration is one-shot and additive.** Legacy ids become unique, slug-safe ids; the legacy array is untouched; running it twice changes nothing.
6. **An older app is unaffected.** New fields are ignored, and the legacy array is still written.

## Success criteria

- The five tools are **on the wire** for a tool-capable endpoint and execute end to end with correlated results (the pattern T19 and T24a established).
- The tag path still works on an endpoint that cannot be sent tool declarations.
- The model can fix its own redundancy with `update`/`remove`/`list` — no engine added.
- Every refusal path leaves the store and the turn intact.

## Risks and open questions

- **Two write paths, one mutator** — the mitigation is the single mutator above; the test is that a tag-created memory and a tool-created memory are indistinguishable afterwards.
- **`memoriesEnabled` off** means *neither* injection *nor* tool declarations — the conservative reading, and the one that keeps "off" meaning off.
- **Earlier revisions are capped**, so revert is bounded. That is a deliberate trade: unbounded history in `Settings` is a slow leak, and the requester's need is undo-one-step plus un-delete, not full version control.
- **Where the titler's cousin lives** — P3 (the auto-titler) is a separate area and a separate spec; nothing here assumes it.
- **Transient state is handled by guidance, not by a `scope` field — a ruling, not an omission.** The consumer asked for a session-scoped tag so that "the assistant glitched twice this session" could not become permanent. The *need* is met by the prompt rule (never record per-session transient state) plus the model's own `memory_remove`, so an auto-purged `scope` is **deferred**: "session" has no definition in this app (a conversation? an app run? a working day?), and inventing one would impose a rule the user never sees and cannot correct. Cost if wrong: a transient note persists until the model or the user removes it — visible in the UI, which is where it should be noticed.

## Out of scope

Similarity dedupe; embeddings; shared memory; any memory UI in the composer; automatic memory *reading* beyond the existing injection.
