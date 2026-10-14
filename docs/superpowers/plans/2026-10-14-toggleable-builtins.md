# Toggleable Built-ins (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every built-in area of the app becomes a named, individually toggleable unit with a per-contribution drill-down, so the app is a host plus contributions rather than a host of hardcoded features.

**Architecture:** Reuse the loader's already-proven trace-free teardown — each area registers through a host built with **its own `Scope`**, and a toggle persists then **reconciles** (close the area, re-register what is enabled). One new module owns the area list, one owns the semantics; storage is additive (an absent field means everything on, so there is no migration).

**Tech Stack:** TypeScript, React 19, Effect, zod (the Settings schema), `bun:test`. Rust is untouched.

**Spec:** `docs/superpowers/specs/2026-10-14-toggleable-builtins-design.md`

## Global Constraints

- **No new dependency.**
- Inside `web/src`: no `async`/`await`/`throw`/`try`/`catch`/`new Promise` (enforced by GritQL plugins) — Effect idioms only; test files are exempt.
- Never `mock.module` a project module — inject through an existing seam.
- `cd web && bun run verify` is the gate (`tsc -b`, `biome check .`, effect-language-service, `bun test`); `cargo check --all-targets` stays clean.
- Markdown: **one line per bullet, never hard-wrapped.** Biome: tabs, `indentWidth` 4.
- Never put an `onClick` that calls `preventDefault` on a `<summary>` (a shipped bug in this repo).
- Commits: conventional; `git add` a brand-new file **first**, then `git commit --only <paths>` (it refuses an untracked path); **no measured number in a message**; `rg` scoped, never `grep`.

## Review Focus

Each line gets its test in the task named, because the spec implies the behaviour without any single task's tests covering it by default.

1. **A persisted contribution id that no longer exists** (a renamed built-in contribution) — the app must still boot with everything else enabled. *(T2)*
2. **Disabling the only route back to the manager** — impossible, including via the bare preset. *(T2, T5)*
3. **A reconcile that throws mid-registration** — never a half-registered area; the previous state survives. *(T3)*
4. **Real older data with no `builtins` field** — every area on, no migration, an older app unaffected. *(T2)*
5. **Toggling an area off→on→off→on** — no duplicated registrations. *(T3)*

## File Structure

- `web/src/lib/plugins/areas.ts` *(new)* — the area table: id, label, description, locked flag, and the area's existing registrar.
- `web/src/state/builtins.ts` *(new)* — the store: snapshot + `useBuiltins`, the toggles, the bare preset, restore-all, reconcile, locked enforcement.
- `web/src/lib/db/types.ts` *(modify)* — the additive `builtins` field on the Settings schema.
- `web/src/main.tsx` *(modify)* — boot through the store's registration instead of calling `registerBuiltins` directly.
- `web/src/lib/plugins/builtin/index.ts` *(modify)* — the aggregator the area table replaces or delegates to.
- `web/src/ui/plugins/BuiltinsArea.tsx` *(new)* + `web/src/ui/plugins/PluginsSection.tsx` *(modify)* — the UI.

---

### Task 1: The area table

**Files:**
- Create: `web/src/lib/plugins/areas.ts`
- Test: `web/src/lib/plugins/areas.test.ts`

**Interfaces:**
- Produces: `interface BuiltinArea { readonly id: string; readonly label: string; readonly description: string; readonly locked?: boolean; readonly register: (host: Host) => void }` and `export const BUILTIN_AREAS: readonly BuiltinArea[]`, `export const LOCKED_BUILTIN_IDS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// areas.test.ts
test("every area id is a valid, unique builtin id", () => {
  const ids = BUILTIN_AREAS.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(BUILTIN_ID_PATTERN.test(id)).toBe(true);
});
test("the table covers every registrar in builtin/index.ts", () => {
  // enumerate the register*Builtins exports of builtin/** and assert each
  // appears in exactly one area's `register`
  expect(covered).toEqual(allRegistrars);
});
test("the locked set is exactly the substrate and the manager", () => {
  expect(LOCKED_BUILTIN_IDS).toEqual(["app.substrate", "app.builtins"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && bun test src/lib/plugins/areas.test.ts`
Expected: FAIL — `areas.ts` does not exist.

- [ ] **Step 3: Implement the table**

The nine areas and their registrars, all of which exist today: `app.shell` → `registerShellBuiltins`, `app.transcript` → `registerTranscriptBuiltins`, `app.composer` → `registerComposerBuiltins`, `app.overlay` → `registerOverlayBuiltins`, `app.settings` → `registerSettingsBuiltins`, `app.themes` → `registerThemeBuiltins`, `app.tools` → `registerToolBuiltins`, `app.commands` → `registerCommandBuiltins`, `app.providers` → `registerProviderBuiltins`. Add `app.substrate` (the locked container, whose `register` is a no-op in this task) and mark `app.builtins` locked — the manager section's id comes from the Plugins section's existing registration in `builtin/settings.ts`. Each `description` states what disappears when the area is off, in one user-facing sentence; `app.shell`'s says the container will be left empty.

- [ ] **Step 4: Run it and watch it pass** — same command, expect PASS.

- [ ] **Step 5: Commit** — `git add web/src/lib/plugins/areas.ts web/src/lib/plugins/areas.test.ts && git commit --only … -m "feat(plugins): name every built-in area"`.

---

### Task 2: Persisted state and store semantics

**Files:**
- Modify: `web/src/lib/db/types.ts`
- Create: `web/src/state/builtins.ts`
- Test: `web/src/state/builtins.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_AREAS`, `LOCKED_BUILTIN_IDS` (T1); the Settings store's read/write seam.
- Produces: `interface BuiltinsSnapshot { readonly enabled: boolean; readonly contributions: Readonly<Record<string, Readonly<Record<string, boolean>>>> }`, `useBuiltins()`, `setBuiltinEnabled(id: string, on: boolean): void`, `setContributionEnabled(areaId: string, contributionId: string, on: boolean): void`, `applyBarePreset(): void`, `restoreAllBuiltins(): void`.

- [ ] **Step 1: Write the failing tests**

```ts
test("an absent builtins field means every area is on", …);           // legacy data
test("an unknown area or contribution id is ignored", …);             // renamed contribution
test("a locked area refuses to be disabled and says why", …);         // app.builtins / app.substrate
test("the bare preset disables every non-locked area and no locked one", …);
test("restore-all re-enables everything", …);
test("a toggle round-trips through the settings write seam", …);
```

- [ ] **Step 2: Run them and watch them fail** — `cd web && bun test src/state/builtins.test.ts`.

- [ ] **Step 3: Implement**

Add to `db/types.ts`: `builtins: z.record(z.object({ enabled: z.boolean().optional(), contributions: z.record(z.boolean()).optional() })).optional()` — optional, so **no migration** and older data is untouched. In `state/builtins.ts`, mirror `state/plugins.ts`'s shape: a module snapshot with a **stable identity** (an unstable snapshot loops `useSyncExternalStore` forever), `subscribe`/`getSnapshot`, and a write that goes through the existing settings seam. Defaults are computed, not stored: an absent area is on, an absent contribution is on. The locked check is enforced here, in the store, so a future UI cannot bypass it.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 3: Registration and reconcile (the Scope mechanism)

**Files:**
- Modify: `web/src/main.tsx`, `web/src/lib/plugins/builtin/index.ts`
- Test: `web/src/state/builtins.test.ts` (integration), `web/src/lib/plugins/areas.test.ts`

**Interfaces:**
- Consumes: T1's table, T2's store, the host factory that already takes `(services, pluginId, scope)`.
- Produces: `reconcileBuiltins(services): Effect.Effect<void>` and the boot path that uses it; each live area is tracked as `{ id, scope }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("with everything on, every area's contributions are registered", …);
test("disabling one area empties exactly that area's registrations", …);      // counts per registry
test("off → on → off → on leaves no duplicates", …);                           // Review Focus 5
test("a register that throws leaves the previous registrations intact", …);    // Review Focus 3
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement**

Per area: `Scope.make()`, build a host with `makeHost(services, area.id, scope)`, call `area.register(host)`, keep `{ id, scope }`. A toggle or preset **reconciles**: close every live area's scope, then register each enabled area — idempotent, and the same close-then-register shape `state/plugins.ts` already uses. Reconcile is atomic per area: a failure is caught, the area id is logged, and if nothing registered the previous state is kept. `main.tsx` calls the store's initial reconcile instead of `registerBuiltins(host)` directly.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 4: Per-contribution toggles

**Files:**
- Modify: `web/src/state/builtins.ts`, the registrars in `web/src/lib/plugins/builtin/**` where a contribution lacks an id
- Test: `web/src/state/builtins.test.ts`

**Interfaces:**
- Produces: the filter rule — a contribution is registered unless `contributions[areaId][contributionId] === false`, where `contributionId` is the id the registry already holds for it (a registry entry's `id`; a tool's wire name; a command's id; a settings section's id). Where an entry has no `id`, the registrar gains one rather than the toggle layer inventing a parallel namespace.

- [ ] **Step 1: Write the failing tests** — for `app.tools`, disabling `fetch_url` leaves `web_search` registered and the registry empty of `fetch_url`; for one UI area, disabling a single contribution leaves its siblings registered.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** the filter at registration time (a disabled contribution is simply never registered, so "off" is indistinguishable from "never existed"). Report which areas needed an id added.

- [ ] **Step 4: Run and watch them pass.**

- [ ] **Step 5: Commit.**

---

### Task 5: The UI

**Files:**
- Create: `web/src/ui/plugins/BuiltinsArea.tsx`
- Modify: `web/src/ui/plugins/PluginsSection.tsx`
- Test: `web/src/ui/plugins/BuiltinsArea.test.ts` (the pure part)

**Interfaces:**
- Produces: `builtinRows(snapshot): readonly BuiltinRow[]` (a pure view-model: id, label, description, enabled, `lockedReason?`, contributions with their own state) and the component that renders it.

- [ ] **Step 1: Write the failing test** — a locked area's row carries a `lockedReason`; a disabled area's contributions are still listed for re-enabling; the bare-preset row is present.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement** the view-model and the component: one row per area (label, the one-line "what disappears", a toggle, an expander), per-contribution toggles inside, `Bare preset` + `Restore all`, and one honest line that a disabled built-in stays off until re-enabled here and that the manager itself cannot be disabled. Wire it into the Plugins section using that section's existing idioms (its `Button`, its copy style) — no second idiom. No `onClick` on a `<summary>`.

- [ ] **Step 4: Run it and watch it pass**, then check in a browser (`agent-browser`, own session, never `close --all`): the section renders, no console errors, the manager reachable.

- [ ] **Step 5: Commit.**

---

### Task 6: The invariant and the browser proof

**Files:**
- Test: `web/src/state/builtins.test.ts`
- Report: `.superpowers/sdd/2026-10-12-plugin-system/task-p1-report.md` (gitignored)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing invariant test** — with every non-locked area off, the registries hold exactly the locked contributions and nothing else; restoring returns identical counts to before. (A count-based proxy for "the substrate alone"; the DOM claim is proven in the browser step below.)

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Make it pass** (no production change expected — this is the invariant the design predicts).

- [ ] **Step 4: Prove it in a browser on the production bundle** (`bunx vite build && bunx vite preview`, own `agent-browser` session, never `close --all`): each area toggles off and on with a **live page sentinel** so a reload cannot fake it; per-contribution toggles; the bare preset; restore-all; the manager reachable throughout; `agent-browser errors` clean. Record the transcript in the report.

- [ ] **Step 5: Commit** the test; state plainly what the browser run could not prove.

---

## Self-Review

**Spec coverage:** goal 1 (area toggles, reversible, trace-free) → T3; goal 2 (per-contribution) → T4; goal 3 (locked core) → T2 (enforcement) + T5 (UI); goal 4 (additive, no migration) → T2; goal 5 (bare preset + restore-all) → T2 + T5; goal 6 (store-enforced, not UI-only) → T2. Spec's "nine areas" → T1. Spec's invariant tests → T3 (registry) + T6 (DOM/browser). Spec's error handling → T2 (locked refusal) + T3 (atomic reconcile, area id in the log).

**Step scan:** every step names its file, its command, or its exact assertion. No step carries a function body the signature and tests already determine.

**Type consistency:** `BuiltinArea` (T1) is consumed unchanged in T3 and T5; `BuiltinsSnapshot` (T2) is the only snapshot type; `setBuiltinEnabled` / `setContributionEnabled` / `applyBarePreset` / `restoreAllBuiltins` keep those names and arities in T3–T6; `LOCKED_BUILTIN_IDS` is the single source for the locked set in T2 and T5.

**Review Focus:** all five lines have their test in the named task (1, 2, 4 → T2; 3, 5 → T3).

**Proportion:** six tasks, one test cycle each, no bodies beyond what the names and assertions leave open.

## Out of scope (stated so it is not mistaken for an omission)

Third-party per-contribution toggles; a core-plugin tier; build-time bundling of core plugins; reordering within an area; the memory redesign (P2) and the auto-titler (P3), each with its own spec and plan.
