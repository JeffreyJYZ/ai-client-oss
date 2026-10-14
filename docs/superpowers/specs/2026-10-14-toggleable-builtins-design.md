# Toggleable built-ins (P1) — design

Status: **design approved in conversation, awaiting review of this written spec.** P2 (the memory redesign) is specified separately and rides on this one.

## Purpose

Every built-in area of the app becomes a **named, individually disableable unit**, with a per-contribution drill-down, so the app is *a host plus contributions* rather than *a host of hardcoded features*.

Motivation, in the requester's words: *"built ins shld be able to be turned off, no? i want 2 for everything. max customisation!"* — a built-in you cannot turn off is a hardcoded app, which contradicts the objective the plugin system already claims ("modify all UI, move everything, control all logic"). The built-ins are built through the same public API as any plugin, so the only thing missing is the ability to *name, disable and restore* them.

## What exists today (facts, not assumptions)

- **Nine registrars**, one per area: `web/src/lib/plugins/builtin/{shell,transcript,composer,overlay,settings,themes,tools,commands,providers}(.ts|/index.ts)`, each exporting `register*Builtins(host: Host): void`.
- They are aggregated by `registerBuiltins(host)` (`builtin/index.ts`) and called **once at boot** (`web/src/main.tsx`) before React mounts.
- **They have no plugin identity.** Registration is anonymous; `registerToolBuiltins` passes no `pluginId` (a built-in tool's fault therefore names the built-in host). Nothing in the tree can name one, disable one, or restore one.
- The **master switch** (`Settings.pluginsEnabled`) gates *installed* plugins only; `setPluginEnabled(id, on)` already persists per-plugin enable state.
- `Settings.dataVersion` and `db/migrate.ts` exist; `migrations` is **empty** (so the first real migration belongs to P2, not here).
- The **loader already gives every plugin a `Scope`** whose close is trace-free — the property the earlier phase gates proved with byte-identity checks. This design reuses it rather than inventing a second teardown.

## Goals

1. One toggle per built-in area, each reversible and leaving **no trace** when off.
2. A per-contribution drill-down **for built-ins**.
3. An **irreducible core** that can never be disabled, so there is always a way back.
4. **Additive** persistence: no migration, and an older app opening newer data is unaffected.
5. A **bare preset** (turn every non-locked built-in off) with **restore-all** beside it.
6. The state is enforced in the store, not merely in the UI.

## Non-goals

- Per-contribution toggles for **third-party** plugins — their contribution ids move as plugins update, so the state would drift. They keep the existing per-plugin enable.
- A "core plugin" tier in the loader, or build-time chunk bundling of core plugins (the route rejected in favour of this one).
- Reordering or hiding contributions *within* an area — the slot registry's own contribution mechanisms own that.
- The memory redesign (P2), which becomes one of these areas.

## Design

### Units and identities

- Each area gets a **stable id**, in the same allowlist spirit as plugin ids but its own schema (different domain, and the plugin rule was written after a real containment bug — no shared denylist): `app.shell`, `app.transcript`, `app.composer`, `app.overlay`, `app.settings`, `app.themes`, `app.tools`, `app.commands`, `app.providers`.
- A **contribution** inside an area is identified by the id its registry already holds for it — **the entry's own `id`**, whatever that entry's kind (a UI/command/provider/pipeline entry's `id`, a tool's `declaration.name`, a theme's `id`, a settings section's `id`, a renderer's `kind`). **No new identity scheme**, and **nothing derived**: an earlier draft said "a slot id plus the contribution's own id", which would have made every per-contribution toggle silently match nothing, since the gate keys on the registry entry's `id` alone. If a contribution had no id, the registry that holds it would gain one rather than the toggle layer inventing a parallel namespace.

### Registration, teardown, reconcile

- **Boot:** for each area, create a `Scope`, register that area's contributions through the public API *with* that scope, and keep `{ id, scope }`.
- **Toggle:** persist the new state, then **reconcile** — close the affected area's scope and re-register only what is enabled. Reconcile is idempotent and follows the shape the plugin store already uses.
- **Why `Scope` rather than a read-time filter:** the loader's teardown is *already proven* trace-free, whereas a filter must be honoured by every consumer of every registry — a cross-cutting invariant with many places to be silently wrong. The rejected alternative is recorded here on purpose.
- A **disabled contribution is simply not registered**, so "off" is indistinguishable from "never existed" — the strongest guarantee available.

### The locked core

- **Locked** (never disableable, and *not* touched by the bare preset): the **container/substrate** that hosts a layout, and the **Plugins manager** section — the way back.
- **Everything else toggles, including `app.shell`.** With the shell off, the container renders an empty surface: a legitimate "bare host" state, and the documented meaning of turning the shell off. (`app.settings` toggles too; only the manager inside it is locked.)
- Locked-ness is enforced **in the store** (a refused toggle with a message), so a future UI cannot bypass it.

### Persistence

- New **additive** field: `Settings.builtins?: Record<string, { enabled?: boolean; contributions?: Record<string, boolean> }>`.
- **Absent means every area and every contribution is enabled** — so there is **no migration**, and an older app that opens this data ignores the field entirely (the downgrade-tolerance property the data layer was built for).
- **Unknown ids are ignored**, which makes the field forward-compatible and makes a renamed built-in contribution's stale state harmless.

### UI

The Plugins section gains a **Built-ins** area:

- one row per area: name, one-line description of what disappears when it is off, a toggle, and an expander;
- per-contribution toggles inside the expander;
- **Bare preset** and **Restore all** actions;
- one honest line stating that a disabled built-in stays off until re-enabled here (and that the manager itself cannot be disabled).

### Error handling

- A toggle on a **locked** unit is refused at the store with a message naming the unit.
- A **reconcile that throws** must not leave the app half-registered: per area the close-then-register pair runs as one unit; on failure the error is reported **with the area id**, and the **failed area is left empty with its partial work rolled back while every other area is untouched** — under close-first that is the only coherent reading, since a deterministically-throwing registrar cannot be "restored". (Wording reconciled after T3's review confirmed the implementation; the earlier phrase "the previous state is restored if nothing registered" was ambiguous.)
- A built-in's fault names its **area** (the same principle as a plugin fault naming its plugin), so the log says which area broke.

### Testing

- **Unit — store semantics:** locked refusal; absent-field default = all on; unknown-id tolerance; contribution-level filtering; toggle → reconcile → state.
- **Invariant (the strongest tests):** with every built-in off, the rendered DOM equals the substrate alone; toggling an area off and back on returns the DOM to its prior state — the same shape as the phase gates that already compare DOM byte-for-byte.
- **Browser proof:** each area's toggle on/off with a live page sentinel (so a reload cannot fake it); the bare preset; restore-all; and the manager staying reachable throughout.
- **Rust:** unaffected — this is entirely a web-side surface. Stated here so the absence of a Rust test is a decision, not an oversight.
- `cd web && bun run verify` and `cargo check --all-targets` stay green.

## Success criteria

1. Nine areas, each with a working toggle that is reversible and trace-free.
2. Per-contribution toggles working for at least one area, with the mechanism generalised (not special-cased).
3. The locked set cannot be disabled **by construction**, including via the bare preset.
4. No migration, and an older app opening this data is unaffected.
5. Adding a tenth area (P2's `app.memory`) is a one-line change to the area list.
6. The existing gates stay green.

## Risks and open questions

- **Turning the shell off** yields an empty surface. Intended, and the manager stays reachable — but this is the one toggle whose "off" state a user might mistake for a broken app, so the row's description must say so plainly.
- **Renaming a built-in contribution** orphans its toggle state. Harmless (ignored), but a future rename should note it.
- **Ordering:** P2 will move the Memories UI out of `Settings.tsx` into a registered section; that move is P2's, not P1's, though P1 is what makes it matter.
- **Reconcile cost:** closing and re-registering all areas on every toggle is cheap at this scale (nine registrars) and chosen for correctness; if it ever costs, per-area reconcile is already the natural next step.

## Out of scope

Third-party per-contribution toggles; a core-plugin tier; build-time bundling of core plugins; reordering within an area; the memory redesign (P2, which rides on this).
