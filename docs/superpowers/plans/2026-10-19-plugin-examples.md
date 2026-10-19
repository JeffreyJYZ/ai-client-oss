# Plugin examples, and a gate that keeps them honest

**Status:** planned 2026-10-19, after 0.6.0 shipped.

## Problem

The plugin system's API reference is generated from the shipped types and gated by a coverage test, but the **examples** — the thing an author copies — are gated by nothing and cover almost none of the surface:

- **1 of 22 slots** has an example (`chat.message.actions`).
- **1 of 6 pipeline stages** (`onToolCall`), **1 of 4 renderer kinds** (none), **0 provider registrations**, **0 component overrides**.
- `host.chat`'s mutating half, `notify.banner/modal/confirm`, `host.run`, 7 of 8 events, `host.native.http/read/list/remove/dataDir`, `storage.delete/keys`, kit beyond `Button` — all documented in the table, none demonstrated.
- **Nothing builds or tests the examples**: `scripts/build-plugins.ts` is manual, `verify` does not run it, and no test enumerates `web/plugins/`. An example can drift from the API and stay "green" forever; the first thing to notice is a user installing a broken plugin.
- The author guide is **wrong in three places**: it says "four plugins" (there are five dirs), it says "no Effect runner" while documenting `host.run` (it means "no synchronous runner", which is true, and the guide does not say that), and `App.tsx` claims a plugin "can replace the whole shell" via `ui.root.layout` — `Slot` renders **every** contribution, so a second root layout renders *alongside* the default; replacement is only visual.

## Goal

Four examples that each teach one unrepresented axis, one harness test that runs every example's `setup` against a recording host and pins its registrations, and a guide whose table says which example teaches what.

**Non-goals:** no new API, no behaviour change, no new dependency, no provider-implementation example (a provider is a full streaming implementation; a subtly wrong copy is worse than a pointer — the guide will point at `lib/plugins/builtin/` instead and say why).

## Examples

| Example | Surface it teaches | Why it is the right one |
|---|---|---|
| `example.zen-view` | `ui.root.layout`, `host.chat.snapshot`/`changes`, kit `Panel`/`Section`/`Markdown`, `host.run` | The only surface that can own the whole window; also the one the current docs describe wrongly |
| `example.sidebar-notes` | `app.sidebar`, `storage.get/set/delete/keys`, `notify.confirm`, `on("conversation-changed")` | A chrome slot with real persistence — the shape most plugins actually want |
| `example.history-pipeline` | `pipeline` stages `beforeSend`, `afterReply`, `onHistory` | Pipeline is the least understood surface; three of six kinds, incl. the one that can abort a turn |
| `example.markdown-callouts` | `renderers.register("markdown", …)`, component-id override, kit `Markdown` as fallback | Component override is the answer to "can I change how messages look?" |

Each is a real, small plugin (roughly 80–140 lines) with a `plugin.json`, a one-paragraph header comment saying **what it teaches and what it deliberately does not do**, and no dependency beyond React + `effect`.

## The gate

`web/src/lib/plugins/examples.test.ts`:

1. Discovers `web/plugins/*/plugin.json` (sorted), so an example cannot be added and silently skipped.
2. Validates each manifest with `manifestSchema` (the same schema install uses).
3. Imports the entry module named by `manifest.entry` (default `main.ts`/`main.tsx`), calls its `setup` with a **recording host**, and asserts: at least one contribution; every registered `slot` is in `slotIds`; every registered `id` is unique across examples; the module exports a `setup` function.
4. Asserts the guide's example table lists exactly the discoverable set — so README and tree cannot drift.
5. `globals-proof/` has no manifest and no `setup`; it stays excluded **by name with a comment**, not by a silent glob miss.

`setup`-time failures are the class the app cannot catch today (a plugin that throws in `setup` looks identical to one that does nothing until someone installs it), so this test is the cheapest place to catch them.

The build still runs by hand for a browser proof, but **the harness must not depend on the built bundle** — it imports the source, exactly as a reader would.

## Global constraints

- `cd web && bun run verify` is the gate; `tsc -b` catches a missing manifest field.
- `bun scripts/build-plugins.ts` must build every example (proves the no-bare-import and JSX-globals path); run it by hand in each lane that adds one.
- No `mock.module`; the recording host is a hand-written fake of `Host` (it is the seam).
- `rg` scoped to a path, never `grep`.
- Each task: red-first evidence for its test, then the implementation.
- The UI examples are not shipped to users (they are docs artifacts) — one production-bundle browser proof for `zen-view` is required because it is the surface with a real DOM risk; the others are proven by the harness + build.

## Tasks

### Task 1 — the harness (and the typecheck that does not exist)

- **First: examples are not typechecked at all.** `web/tsconfig.app.json` includes only `src`, and the solution file references only `app` + `node`. Add `web/tsconfig.plugins.json` (extends the app config, `include: ["plugins"]`, `noEmit`) and reference it from `web/tsconfig.json`, so `tsc -b` finally checks the examples. Prove it with a scratch type error in one example: `tsc -b` must fail.
- Then create `web/src/lib/plugins/examples.test.ts` and `web/src/lib/plugins/examples-host.ts` (the recording host: records `ui.register`, `commands.register`, `tools.register`, `pipeline.register`, `renderers.register`, `providers.register`, `settings.registerSection`, `themes.register`, and no-ops the rest with the real types).
- Starts by covering the four existing examples; a deliberate manifest error must redden it.
- Consider (and only adopt if the five existing examples already comply): extend the `biome-plugins/*.grit` `includes` to `**/web/plugins/**`, so a copied example cannot teach `async`/`try` in an Effect codebase. If an example violates a rule, fix the example — it is documentation.
- Does **not** touch the existing examples' code except a `plugin.json` fix if the schema rejects one.

### Task 2 — `example.zen-view`

- Registers `ui.root.layout` with a **fixed, full-viewport** surface (the correct way to "replace" the shell, given `Slot` renders all), opened by a command and closed by Escape.
- Reads `host.chat.snapshot()` and follows `host.chat.changes` **through `host.run`**, so closing the surface or disabling the area tears the subscription down — the example this repo has been burned by twice.
- Browser proof on the production bundle: open by command, the shell is covered, Escape restores it, no console errors.

### Task 3 — `example.sidebar-notes`

- `app.sidebar`: a notes panel with add/delete, persisted per plugin via `storage` (`keys`/`delete` used, not just get/set).
- `notify.confirm` before deleting; `on("conversation-changed")` re-reads the note bound to the active conversation.
- Harness test asserts the slot and that deleting a note calls `storage.delete` (a recording host makes that visible).

### Task 4 — `example.history-pipeline`

- `onHistory`: trims to the last N turns, with the number in its description.
- `beforeSend`: refuses (aborts the turn with a readable reason) when the prompt is empty after trimming.
- `afterReply`: records one stat line through `host.log`.
- Header comment must state the fail-open contract: a stage that faults is skipped and the request continues with its input unchanged.

### Task 5 — `example.markdown-callouts`

- `renderers.register("markdown", …)`: renders `> [!note]`-style callouts, **delegating every other document** to `host.ui.kit.Markdown`, so the override cannot regress normal rendering.
- Harness test asserts the renderer kind registered and that the component is a function.

### Task 6 — the guide and the doc corrections

- `web/plugins/README.md`: replace the API table's dead ends with a **capability → example** map; fix "four plugins"; fix the "no Effect runner" sentence to say *no synchronous runner, `host.run` forks scoped work*; state the `ui.root.layout` append-vs-replace reality and point at `zen-view`.
- `web/src/ui/App.tsx`'s comment: correct "can replace the whole shell" to the truth (a contribution renders alongside; replacement is visual, as `zen-view` shows).
- `docs/backlog.md`: record the remaining uncovered surfaces (providers, `native.http`, 21 slots) as a known gap with the reason, not a TODO with no owner.
