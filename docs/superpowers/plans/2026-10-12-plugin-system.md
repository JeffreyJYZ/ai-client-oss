# Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app completely extensible with full-trust in-process plugins — registry-assembled UI (slots, replace, hide, order, layout takeover) over the same public API — with zod-derived types, Effect services throughout, and the app's own features re-plumbed as built-in plugins.

**Architecture:** A host core of Effect services (`Context.Tag` + `Layer`, one `ManagedRuntime`) holds registries whose state is a `SubscriptionRef`; plugin lifetime is a `Scope` (one per plugin, closed = unloaded); events ride a `PubSub`; zod schemas are the single source of truth for every data type. A loader turns a manifest + one pre-built import-free ESM file into a `setup(host)` call. React reads registries through `SubscriptionRef.changes` → `useSyncExternalStore`, exactly as the existing stores do.

**Tech Stack:** TypeScript 6, React 19, Effect 4, zod 4, Tailwind v4, Vite 8, bun (`bun test`), Tauri 2 / Rust, Biome 2.5.15 + `@effect/language-service`.

**Spec:** `docs/superpowers/specs/2026-10-12-plugin-system-design.md`

## Global Constraints

- **zod is the source of truth for types.** Anything persisted, parsed from disk, sent on the wire or declared by a plugin is a `z.ZodType` whose type is `z.infer`red at its definition site. Hand-written TS interfaces only for functions, Effects and Streams (registries, services, `Host`).
- **Full Effect.** Services via `Context.Tag` + `Layer`, lifetime via `Scope`, state via `Ref`/`SubscriptionRef`, events via `PubSub`, errors via `Data.TaggedError`. No `async`, `await`, `throw`, `try`/`catch` or `new Promise` inside `web/src` (GritQL-enforced). One `decode` helper is the only place zod meets Effect.
- **No new runtime dependencies.** React, zod, Effect, marked, dompurify only. The plugin build preset uses Vite (already a dependency). Zip import and publishing an SDK package are out of scope.
- **Data compatibility is a hard requirement** (spec §13). Upgrading from a 0.2.3 install must lose nothing and need no manual step; a stored blob that fails to parse is preserved rather than replaced; every schema change ships a frozen-fixture test. A downgrade is *not* compatible — the release note tells users to export a backup first.
- **With zero plugins enabled, rendering and behaviour are identical to today** — same components, same props, same children in the same order.
- **Webview-only UI, dark-first**; desktop and web differ only behind source/bridge adapters (`isDesktop`), never inside the host.
- **Gates stay green:** `bun test`, `biome check .`, `bunx effect-language-service diagnostics --project tsconfig.app.json`, `tsc -b`, `vite build`.
- Where the installed Effect 4 API differs from the names used here (`Context.Tag`, `Data.TaggedError`, `SubscriptionRef`, `PubSub`, `Scope.close`), follow the installed API and keep the documented behaviour — **the tests are the contract.**
- Every commit uses Conventional Commits, `git add` by explicit path, and **no measured number in a message** (test counts go stale; name the gate, not its total).

## Review Focus

Five failure modes the spec implies that the happy paths do not cover. Each line has a test in the task that owns the code.

1. **A plugin fault must never blank the app.** A throw inside `setup`, or inside a contribution's render, has to leave the rest of the UI alive and visible. (T4 setup faults; T5 render error boundary; the browser proof asserts `#root` still has children.)
2. **Zero plugins must not change the DOM.** Slot extraction is the highest-churn change in this plan; a mismatch here ships as a visual regression. (T6–T9 each compare the browser before/after.)
3. **Name collisions.** Two plugins contributing the same contribution id, or registering a tool/protocol whose name a built-in already owns, must resolve by a stated rule rather than by accident. (T2 duplicate contribution id; T10 tool name; T11 protocol name.)
4. **Pre-existing stored data.** A `settings.json`/IndexedDB blob written before plugins existed, or referencing a protocol whose plugin is now disabled, must parse and degrade readably — and a blob that *doesn't* parse must never be silently replaced by defaults. (T0.1 rejected-blob safety net; T0.2 per-field tolerance; T0.3 frozen fixtures; T1 `Settings` decode; T11 unknown protocol → failed turn, not a crash.)
5. **A bad middleware must not hang or kill a turn.** A faulting stage is skipped (fail-open), a `beforeSend` that returns `null` aborts with an error row, and a chunk-dropping stage still lets the stream terminate. (T12.)

**Routing for whoever executes this** (see per-task notes): T6–T9 are mechanical migrations and T19 is fixtures — free-model subagent work; T0.1–T0.3 (data safety), T1–T5, T10–T18, T20–T22 are review-class. Every subagent brief must carry, as its own line: `DO NOT WASTE TURNS: do as much as possible in one turn — batch every independent call, chain dependent steps, never yield between them`, and require the deliverable written to disk early.

---

## Phase 0 — Spine

### Task 1: Test wiring, zod spine and plugin settings state

**Files:**
- Modify: `web/package.json` (add `"test": "bun test"`)
- Modify: `biome.jsonc` (append `"!**/*.test.ts"` to each of the five plugins' `includes`)
- Delete: `docs/plugin-seam-inventory.md` (scratch recon; its content is captured in spec §4 and this plan's file lists)
- Create: `web/src/lib/plugins/ids.ts`, `web/src/lib/plugins/manifest.ts`, `web/src/lib/plugins/errors.ts`, `web/src/lib/plugins/effect.ts`
- Modify: `web/src/lib/db/types.ts` (`Settings` gains two keys)
- Test: `web/src/lib/plugins/manifest.test.ts`

**Interfaces:**
- Produces: `slotIds` / `slotIdSchema` / `SlotId`; `capabilityIds` / `capabilitySchema` / `Capability`; `hostEventNames` / `hostEventSchema` / `HostEvent`; `manifestSchema` / `PluginManifest`; `pluginStateSchema` / `PluginState`; `ManifestInvalid` / `PluginLoadFailed` / `PluginFault` / `ApiVersionIncompatible` / `CapabilityUnknown` (all `Data.TaggedError`); `decode(schema, onError)`.

- [ ] **Step 1: Wire the test runner**

Add `"test": "bun test"` to `web/package.json` scripts; append `"!**/*.test.ts"` to the `includes` array of each of the five entries in `biome.jsonc` `plugins` (tests legitimately use `async`/`await`, which the Grit rules ban and which apply to `**/web/src/**`).

- [ ] **Step 2: Write the failing test** — `web/src/lib/plugins/manifest.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { manifestSchema } from "@lib/plugins/manifest";
import { Settings } from "@lib/db/types";

describe("manifestSchema", () => {
	test("accepts a minimal manifest and defaults entry and capabilities", () => {
		const m = manifestSchema.parse({ id: "a.b", name: "B", version: "1.0.0", apiVersion: "0.1" });
		expect(m.entry).toBe("main.js");
		expect(m.capabilities).toEqual([]);
	});
	test("rejects a missing id, an unknown capability and a blank version", () => {
		expect(manifestSchema.safeParse({ name: "B", version: "1", apiVersion: "0.1" }).success).toBe(false);
		expect(manifestSchema.safeParse({ id: "a", name: "B", version: "1", apiVersion: "0.1", capabilities: ["teleport"] }).success).toBe(false);
		expect(manifestSchema.safeParse({ id: "a", name: "B", version: "", apiVersion: "0.1" }).success).toBe(false);
	});
});

describe("Settings", () => {
	test("a blob written before plugins existed still parses", () => {
		const parsed = Settings.parse({ providers: [], activeProviderId: "" });
		expect(parsed.pluginsEnabled).toBe(false);
		expect(parsed.plugins).toEqual([]);
	});
	test("round-trips plugin state with unknown per-plugin data", () => {
		const parsed = Settings.parse({ plugins: [{ id: "a.b", enabled: true, version: "1.0.0", capabilities: [], data: { any: { shape: 1 } } }] });
		expect(parsed.plugins[0]?.data).toEqual({ any: { shape: 1 } });
	});
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd web && bun test src/lib/plugins/manifest.test.ts` — Expected: FAIL, cannot resolve `@lib/plugins/manifest`.

- [ ] **Step 4: Write `ids.ts`** — the three `as const` tuples with their `z.enum` schemas and `z.infer`red types. `slotIds` is exactly spec §4's map: `ui.root.layout`, `app.sidebar`, `app.sidebar.actions`, `app.header`, `app.header.title`, `app.header.actions`, `app.notices`, `app.banner`, `chat.pane`, `chat.messages`, `chat.message`, `chat.message.actions`, `chat.empty`, `chat.stream-status`, `composer.root`, `composer.toolbar`, `composer.actions`, `settings.root`, `settings.nav`, `settings.sections`, `overlay.root`, `command.palette.results`. `capabilityIds`: `plugin-data`, `net`, `window`, `shortcuts`, `invoke`, `fs-any`. `hostEventNames`: `turn-start`, `chunk`, `turn-end`, `conversation-changed`, `settings-changed`, `tool-called`, `plugin-loaded`, `plugin-unloaded`.

- [ ] **Step 5: Write `errors.ts`** — one `Data.TaggedError` class per failure, each carrying `{ readonly detail: string; readonly pluginId?: string }`.

- [ ] **Step 6: Write `manifest.ts`** — `manifestSchema` exactly per spec §6 (`id`/`name`/`version` non-empty strings, `apiVersion`, `entry` default `"main.js"`, `capabilities` default `[]` validated against `capabilitySchema`, `engines` object defaulting `{ app: "*" }`, `description`/`author`/`homepage` default `""`), plus `pluginStateSchema` (`id`, `enabled`, `version`, `capabilities: z.array(z.string())`, `data: z.record(z.string(), z.unknown())`). **Import nothing from `@lib/db` here** — `db/types.ts` imports this module, so an import back would be a cycle.

- [ ] **Step 7: Write `effect.ts`** — the `decode` helper from spec §3, typed so the error constructor is a parameter.

- [ ] **Step 8: Add the two `Settings` keys** — `pluginsEnabled: z.boolean().default(false)` and `plugins: z.array(pluginStateSchema).default([])`, importing `pluginStateSchema` from `@lib/plugins/manifest`.

- [ ] **Step 9: Run the tests, then the gates**

Run: `cd web && bun test && bunx tsc -b && bun run lint` — Expected: PASS, no tsc or lint findings.

- [ ] **Step 10: Commit**

```bash
git add web/package.json biome.jsonc web/src/lib/plugins web/src/lib/db/types.ts
git rm --cached docs/plugin-seam-inventory.md 2>/dev/null; rm -f docs/plugin-seam-inventory.md
git commit -m "feat(plugins): zod spine, ids, tagged errors and plugin settings state"
```

---

### Task 2: Registry primitive with Effect scope lifetime

**Files:**
- Create: `web/src/lib/plugins/registry.ts`
- Test: `web/src/lib/plugins/registry.test.ts`

**Interfaces:**
- Consumes: `ids.ts`, `errors.ts`.
- Produces: `RegistryEntry` (`{ readonly id: string; readonly owner: string; readonly order?: number; readonly priority?: number }`), `Registry<E>` with `add(entry): Effect.Effect<Disposable>`, `entries(): Effect.Effect<readonly E[]>`, `ownedBy(owner): Effect.Effect<readonly E[]>`, `changes: Stream.Stream<readonly E[]>`, and `makeRegistry<E>(name)`: `Effect.Effect<Registry<E>>`. `Disposable` is `{ readonly dispose: () => void }`.

- [ ] **Step 1: Write the failing test** — `web/src/lib/plugins/registry.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { makeRegistry } from "@lib/plugins/registry";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

describe("registry", () => {
	test("sorts by order, then priority, then registration order", async () => {
		const r = await run(makeRegistry<{ id: string; owner: string; order?: number; priority?: number }>("t"));
		await run(r.add({ id: "b", owner: "p1", order: 2 }));
		await run(r.add({ id: "a", owner: "p1", order: 1 }));
		await run(r.add({ id: "c", owner: "p1" }));
		expect((await run(r.entries())).map((e) => e.id)).toEqual(["a", "b", "c"]);
	});
	test("a duplicate id replaces in place and logs, never duplicates", async () => { /* add same id twice; expect one entry, later value wins */ });
	test("dispose removes only that entry", async () => { /* add two, dispose one, expect the other */ });
	test("a plugin scope closes every registration it made", async () => {
		const r = await run(makeRegistry<{ id: string; owner: string }>("t"));
		const scope = await run(Scope.make());
		await run(Effect.provideService(Effect.gen(function* () { yield* r.add({ id: "x", owner: "p1" }); yield* r.add({ id: "y", owner: "p1" }); }), Scope.Scope, scope));
		await run(Scope.close(scope, Exit.void));
		expect(await run(r.ownedBy("p1"))).toEqual([]);
	});
	test("changes emits on add and on dispose", async () => { /* Stream.take 2 over changes, mutate between, expect two snapshots */ });
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd web && bun test src/lib/plugins/registry.test.ts` — Expected: FAIL, cannot resolve `@lib/plugins/registry`.

- [ ] **Step 3: Implement `makeRegistry`** — state is `Ref<readonly E[]>`; `add` appends (replacing a same-`id` entry in place, keeping its position) and registers its own removal as a `Scope` finalizer with the ambient scope; expose the list as a `SubscriptionRef` (or a `Ref` + a `PubSub` the `changes` stream reads). Ordering is computed on read: `order ?? Infinity`, then `priority ?? 0` descending, then insertion index.

- [ ] **Step 4: Run the tests → PASS**, then `cd web && bunx tsc -b && bun run lint`.

- [ ] **Step 5: Commit** — `git add web/src/lib/plugins/registry.* && git commit -m "feat(plugins): registry primitive with Effect scope lifetimes"`

---

### Task 3: Host services, runtime and the per-plugin `Host` object

**Files:**
- Create: `web/src/lib/plugins/host.ts`, `web/src/lib/plugins/runtime.ts`
- Test: `web/src/lib/plugins/host.test.ts`

**Interfaces:**
- Consumes: `registry.ts`, `ids.ts`, `manifest.ts`, `errors.ts`.
- Produces: `Host` and `Plugin` types (spec §2) re-exported from `host.ts`; `makeHost(registries, pluginId, scope): Host`; `HostServices` (`Context.Tag`) carrying every registry; `HostLayer: Layer<HostServices>`; `runtime: ManagedRuntime` from `runtime.ts` for React/boot callers only.

- [ ] **Step 1: Write the failing test** — `web/src/lib/plugins/host.test.ts`: an unknown slot id logs a `PluginFault` and does not throw; every `host.<registry>.register*` returns a `Disposable` that removes exactly its entry; `Scope.close` on the plugin's scope removes everything that plugin registered.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement `HostServices` + `HostLayer`** — one `Context.Tag` service holding a `Registry` per registry kind (slots/contributions, tools, providers, pipeline stages, commands, keybindings, settings sections, renderers, themes). Registries are created once in the layer's construction.

- [ ] **Step 4: Implement `makeHost`** — sync registration is `runtime.runSync(registry.add(entry))` with the finalizer added to the passed scope, and `Disposable.dispose` forks the removal. Validate slot ids against `slotIdSchema` before adding; an invalid id is `Effect.logWarning` + a `Disposable` that does nothing. Sync/Effect split per spec §2: `ui`/`commands`/`tools`/`providers`/`themes`/`renderers` are sync registries; `chat`/`db`/`storage`/`pipeline`/`on` return Effects/Streams.

- [ ] **Step 5: Implement `runtime.ts`** — the `ManagedRuntime` built from `HostLayer`.

- [ ] **Step 6: Tests → PASS**, then `tsc -b` + `lint`.

- [ ] **Step 7: Commit** — `feat(plugins): host services, runtime and per-plugin host`  *Interface note: this is the API every later task's built-ins register against — a change here ripples everywhere, so it is review-class work.*

---

### Task 4: Loader — manifest to module to `setup`, with failure isolation

**Files:**
- Create: `web/src/lib/plugins/loader.ts`, `web/src/lib/plugins/version.ts`
- Test: `web/src/lib/plugins/loader.test.ts`

**Interfaces:**
- Consumes: `manifest.ts`, `host.ts`, `effect.ts`.
- Produces: `PluginSource` (`list(): Effect<readonly unknown[]>`, `read(id, relPath): Effect<string, PluginLoadFailed>`); `ModuleImporter` (`importSource(source: string, name: string): Effect<PluginModule, PluginLoadFailed>`); `PluginModule` (`{ readonly setup: (host: Host) => void | Disposable }`); `LoadedPlugin` (`{ readonly manifest: PluginManifest; readonly scope: Scope.Scope }`); `loadPlugin(manifest, deps): Effect<LoadedPlugin, PluginError>`; `unloadPlugin(p): Effect<void>`; `satisfiesApiVersion(host, manifest): Effect<void, ApiVersionIncompatible>`.

- [ ] **Step 1: Write the failing test** — `web/src/lib/plugins/loader.test.ts` with a fake `PluginSource` and a fake `ModuleImporter` (the real importer is a blob import, browser-only, so it is injected — never imported directly here).

Tests to pin: an invalid manifest never reaches `setup` and reports `ManifestInvalid`; a `setup` that throws leaves the app alive, closes the scope and returns a `PluginFault`; a `setup` that never returns is a timeout load failure (`Effect.timeout`); a `setup` that registers into a bad slot still loads (the fault is dropped, the plugin survives); `apiVersion` `1.0` against host `0.1` is `ApiVersionIncompatible` while `0.2` only logs a warning; `unloadPlugin` removes every registration.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement `version.ts`** — parse `major.minor` from both sides and compare (a `string`, not semver ranges: `engines.app` is checked with a plain `>=` compare against the Tauri version, and anything unparsable is a warning, not a refusal).

- [ ] **Step 4: Implement `loader.ts`** — `Scope.make()`, then `read` entry → `importSource` → `setup(host)` inside the scope, with `Effect.timeout` around the read+import+setup unit and `Effect.catchAllCause` mapping every cause to a tagged error; on failure close the scope. Deliberate: the module's default export is `{ setup }` only — **plugin identity comes from the manifest**, so a module cannot claim another plugin's id.

- [ ] **Step 5: Tests → PASS**, then `tsc -b` + `lint`.

- [ ] **Step 6: Commit** — `feat(plugins): loader with scoped lifecycle and failure isolation`

---

## Phase 0b — Data safety and migrations

Do this before Phase 1 and before any release. Nothing here is plugin work, but the plugin system is what would otherwise foot the bill: the app auto-updates, so this change reaches real installs with real data, and there is no post-hoc rollback for a wiped settings file.

### Task 0.1: Settings safety net — never silently replace an unreadable blob

**Files:**
- Modify: `web/src/lib/db/types.ts` (`Db` gains two methods), `web/src/lib/db/web.ts`, `web/src/lib/db/tauri.ts`, `web/src/ui/Settings.tsx` (a banner in the Backup section)
- Test: `web/src/lib/db/safety.test.ts`

**Interfaces:**
- Produces: `Db.rejectedSettings(): Effect.Effect<Option.Option<string>>` (the raw stored text when the last read failed to parse) and `Db.resetRejectedSettings(): Effect.Effect<void>` (the user's explicit "start fresh").
- Contract change: `Db.setSettings` **fails** (`Effect.fail("stored settings are unreadable; refusing to overwrite")`) while a rejection is outstanding, instead of writing defaults over the file.

- [ ] **Step 1: Write the failing test** — `safety.test.ts`, against both adapters with their storage faked (a `localStorage` stub; a fake `invoke` for the Tauri adapter).

Tests to pin: a corrupt blob makes `getSettings()` return defaults **and** leaves the stored text byte-identical; `getSettings()` alone (the boot path) never writes; `setSettings({…})` while a rejection is outstanding fails and the store is still byte-identical; `rejectedSettings()` returns the raw text; `resetRejectedSettings()` then `setSettings` succeeds and writes; a *valid* blob records no rejection and behaves exactly as before.

- [ ] **Step 2: Run it and watch it fail** — the current adapters write defaults over the corrupt blob, so the byte-identical assertions fail.

- [ ] **Step 3: Implement the safety net** — record the rejection in a module-level cell per adapter (set in `getSettings`, cleared by `resetRejectedSettings`); guard `setSettings` on it; no sidecar file and no new Rust command — on desktop the original file is simply never overwritten.

- [ ] **Step 4: Surface it** — a banner in the Backup section when `rejectedSettings()` is `Some`: it explains that the stored settings could not be read, offers the raw text as a download, and offers a two-step "Reset settings" that calls `resetRejectedSettings()`.

- [ ] **Step 5: Tests → PASS**, then `tsc -b` + `bun run lint` + `bun test`.

- [ ] **Step 6: Commit** — `fix(db): preserve an unreadable settings blob instead of replacing it`

### Task 0.2: `dataVersion`, migration registry, per-field tolerance, plugin-data cap

**Files:**
- Create: `web/src/lib/db/migrate.ts`
- Modify: `web/src/lib/db/types.ts` (`dataVersion`, tolerant `protocol`), `web/src/lib/db/web.ts` + `web/src/lib/db/tauri.ts` (apply migrations on read), `web/src/lib/plugins/manifest.ts` (the per-plugin data cap constant)
- Test: `web/src/lib/db/migrate.test.ts`

**Interfaces:**
- Produces: `DATA_VERSION` (a number), `migrations: readonly Migration[]` where `Migration = { readonly to: number; readonly run: (input: unknown) => unknown }`, and `migrateSettings(raw: unknown): Effect.Effect<unknown, string>` applying every migration whose `to` is above the blob's `dataVersion`, in order, each exactly once, with a pre-migration `exportBackup`.
- Consumes: Task 0.1's rejection path (a migration that faults is a rejection, not a wipe).

- [ ] **Step 1: Write the failing test** — `migrate.test.ts`: a blob with no `dataVersion` and one with `dataVersion: 0` both end at `DATA_VERSION`, running each migration once in ascending order (assert the calls, not just the result); a re-run over an already-current blob applies nothing (idempotent); a migration that faults leaves the blob untouched, reports, and routes into Task 0.1's rejection path rather than defaulting; a `protocol` of the wrong type (a number) degrades to the default **for that provider only** while its siblings survive; a missing `protocol` still gets today's default.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `migrate.ts`** with `migrations` **empty** for this release — the machinery is the deliverable. The pre-migration backup calls the existing `exportBackup`; its failure is logged and does not block the migration.
- [ ] **Step 4: Make `protocol` tolerant** — defaulted then caught, so a missing value is the default and a bad value degrades to it instead of failing the whole `Settings` object.
- [ ] **Step 5: Cap plugin data** — a documented per-plugin byte limit on `plugins[].data` writes, enforced in the storage service path, so a plugin cannot balloon `settings.json` or a backup. (Task 16 implements the writes; add the check there and assert it here.)
- [ ] **Step 6: Tests → PASS**, then `tsc -b` + `bun run lint` + `bun test`.
- [ ] **Step 7: Commit** — `feat(db): data version, migration registry and per-field settings tolerance`

### Task 0.3: Frozen fixtures and the compatibility gate

**Files:**
- Create: `web/src/lib/db/__fixtures__/settings-pre-plugins.json`, `web/src/lib/db/__fixtures__/conversation-pre-plugins.json`, `web/src/lib/db/__fixtures__/backup-pre-plugins.json`
- Test: `web/src/lib/db/compat.test.ts`

**Interfaces:**
- Consumes: `Settings`, `conversationSchema`, `backupSchema`, Task 0.1's contract, Task 0.2's `migrateSettings`.

- [ ] **Step 1: Write the fixtures** from the 0.2.3 shape — the nine settings keys with realistic values (a couple of providers, a profile, two memories, a TinyFish key), one conversation with reasoning and markers, one `BACKUP_VERSION`-1 envelope. Take them from `git show desktop-v0.2.3:<path>` where a real file exists in history, and hand-write only what history cannot supply.
- [ ] **Step 2: Write the test** — `compat.test.ts`: each fixture parses with the current schema and a spot-checked value survives end to end (a provider's `apiKey`, a memory's `text`); the backup fixture imports; a blob carrying a plugin protocol, `plugins[]` and `dataVersion` round-trips; and the **downgrade test** — a 0.2.3-shaped schema (`z.enum(["anthropic","responses","chatcompletions"])` for `protocol`, defined inline) *fails* on that blob, which is asserted to route into the safety net (refused write, stored text intact) rather than a wipe. That last assertion is the one that proves the hazard is fixed rather than described.
- [ ] **Step 3: Run it** — Expected: PASS with Task 0.1 and 0.2 in place.
- [ ] **Step 4: Commit** — `test(db): frozen pre-plugin fixtures pin the upgrade path`

---

## Phase 1 — UI seams

### Task 5: Slot primitives, resolver, React bridge, kit and error boundary

**Files:**
- Create: `web/src/lib/plugins/bridge.ts` (SubscriptionRef → listener store), `web/src/ui/slots/Slot.tsx`, `web/src/ui/slots/useContribution.ts`, `web/src/ui/slots/ContributionBoundary.tsx`, `web/src/ui/kit/classes.ts`, `web/src/ui/kit/index.tsx`
- Modify: `web/src/ui/Settings.tsx` (import `INPUT`/`LABEL`/`BUTTON` from the kit instead of local consts — the kit's first consumer, kept behaviour-identical), `web/src/ui/Composer.tsx` (same for `BUTTON`)
- Test: `web/src/lib/plugins/bridge.test.ts`

**Interfaces:**
- Produces: `subscribeRegistry(cb): () => void` and `getRegistrySnapshot(): readonly Contribution[]` from `bridge.ts`; `<Slot id: SlotId />`, `useComponent(id: string): React.ComponentType<Record<string, unknown>>`; `<ContributionBoundary>`; kit exports `Button`, `Panel`, `Section`, `FieldRow`, `cls`, and the shared class constants `INPUT`, `LABEL`, `BUTTON`, `CONTROL`.
- Consumes: `host.ts`, `ids.ts`.

- [ ] **Step 1: Write the failing test** — `web/src/lib/plugins/bridge.test.ts`: the snapshot is **referentially stable** between mutations (React loops forever otherwise — this is the one assertion that matters here); a mutation produces exactly one new snapshot and one listener call; unsubscribing stops calls.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement `bridge.ts`** — hold the latest snapshot in a module variable; fork one fiber off `SubscriptionRef.changes` (or the registry's `changes` Stream) that writes the new snapshot and notifies listeners; `getRegistrySnapshot` returns the cached array, never a fresh one.

- [ ] **Step 4: Implement the slots and the kit** — `Slot` renders the slot's resolved entries in order, each inside its own `ContributionBoundary` (a class error boundary rendering a small "plugin <owner> failed" line, so a broken contribution cannot blank the page). `useComponent(id)` resolves the highest-priority override, else the built-in registered at `ui.<componentId>`. The kit's classes are lifted verbatim from today's `Settings.tsx:36-43`, `Composer.tsx:8-9`, `ProfilePicker.tsx:5-6`, `ProviderPicker.tsx:3-4` — no visual change.

- [ ] **Step 5: Tests → PASS**, then `tsc -b` + `lint` (`biome check .` will reformat nothing if the lifts are verbatim).

- [ ] **Step 6: Commit** — `feat(ui): slot primitives, registry bridge, component kit`

---

### Task 6: Shell migration — layout, header, notices, and the `ui` store

**Files:**
- Create: `web/src/state/ui.ts`, `web/src/ui/slots/DefaultLayout.tsx`, `web/src/lib/plugins/builtin/ui.ts`
- Modify: `web/src/ui/App.tsx` (renders the root layout slot and the notice/header slots only), `web/src/main.tsx` (boot the plugin runtime + built-ins before `createRoot`), `web/src/ui/UpdateNotice.tsx` (exported as a contribution target, unchanged internally)
- Test: browser proof (below)

**Interfaces:**
- Consumes: Task 5's `Slot`, Task 3's registries.
- Produces: `web/src/state/ui.ts` with `useUIState(): { readonly view: "chat" | "settings"; readonly palette: boolean }`, `setView(view)`, `setPalette(open)`, `subscribe`, `getUIState` (the same `useSyncExternalStore` shape as `state/settings.ts`) — **this replaces `App.tsx`'s `showSettings` local state**, because a slot contribution cannot hold the parent's state and a plugin needs to be able to flip the view too; `DefaultLayout` registered at `ui.root.layout`; contributions registered for `app.header.title`, `app.header.actions` (SystemPrompt, ProfilePicker, ProviderPicker, download link, settings toggle, each with its own order), `app.notices` (install note, `UpdateNotice`).

- [ ] **Step 1: Add `state/ui.ts`** and switch `App.tsx`'s toggle to `setView`/`useUIState` — behaviour identical.

- [ ] **Step 2: Extract the shell** — move `App.tsx`'s `<div>` tree into `DefaultLayout.tsx`, replacing each hardcoded child with `<Slot id="…" />`; register the extracted components in `builtin/ui.ts` with the same order they render today. `App.tsx` keeps only the runtime-initialised shell: `<Slot id="ui.root.layout" />`.

- [ ] **Step 3: Boot the runtime in `main.tsx`** — build the `ManagedRuntime`, register built-ins, then render. Registration is synchronous-in-effect but the runtime boot is Effect; do it before `createRoot` so the first render already sees the registry.

- [ ] **Step 4: Browser proof** — dev-server run, `agent-browser` per the repo's recipe: assert the header controls render in today's order, the settings toggle switches views, the install note and `UpdateNotice` still appear in their conditions, and `agent-browser errors` is clean.

- [ ] **Step 5: Gates + production check** — `cd web && tsc -b && bun run lint && bunx vite build` then `bunx vite preview` and repeat the browser proof (dev serves unbundled ESM and cannot catch bundling faults).

- [ ] **Step 6: Commit** — `refactor(ui): shell layout, header and notices as slot contributions`

---

### Task 7: Migrate the transcript — `ChatPane`, `Message`, renderer slots

**Files:**
- Modify: `web/src/ui/ChatPane.tsx`, `web/src/ui/Message.tsx`, `web/src/lib/plugins/builtin/ui.ts`
- Test: browser proof

**Interfaces:**
- Produces: `chat.pane`, `chat.messages`, `chat.message`, `chat.message.actions`, `chat.empty`, `chat.stream-status` contributions; `useComponent` entries for `ui.message`, `ui.markdown`, `ui.marker`, `ui.reasoning`.

- [ ] **Step 1: Extract** — `ChatPane`'s empty state, message list, streaming indicator and the per-message render become contributions; `Message`'s role label, reasoning `<details>`, markdown body and attachment chips become the `ui.message` built-in, with `chat.message.actions` rendered (empty by default) after the chips.
- [ ] **Step 2: Browser proof** — send a fixture turn (mock endpoint), assert the transcript renders exactly as before, `chat.message.actions` contributes nothing when no plugin is enabled, and the DOM is unchanged from the pre-task build.
- [ ] **Step 3: Gates + production check** (same as Task 6).
- [ ] **Step 4: Commit** — `refactor(ui): transcript regions as slots and renderer overrides`

---

### Task 8: Migrate the composer

**Files:**
- Modify: `web/src/ui/Composer.tsx`, `web/src/lib/plugins/builtin/ui.ts`
- Test: browser proof

**Interfaces:**
- Produces: `composer.root`, `composer.toolbar`, `composer.actions` contributions; `useComponent` entries for `ui.composer` and `ui.attachment-chip`.

- [ ] **Step 1: Extract** — attachment chips, the attach button, the textarea, the Stop and Send buttons become contributions in the order they render today; the composer's own state (`text`, `parts`, `reading`) stays in `Composer` and is passed to contributions as props, so the extraction is a pure move.
- [ ] **Step 2: Browser proof** — attach a file, type, send, stop mid-stream; the transcript and composer behave exactly as before.
- [ ] **Step 3: Gates + production check.**
- [ ] **Step 4: Commit** — `refactor(ui): composer regions as slot contributions`

---

### Task 9: Migrate settings and the sidebar

**Files:**
- Modify: `web/src/ui/ConversationList.tsx`, `web/src/ui/Settings.tsx`, `web/src/lib/plugins/builtin/ui.ts`
- Test: browser proof

**Interfaces:**
- Produces: `settings.root` / `settings.nav` / `settings.sections` and `settings.section:<id>` contributions for all nine existing sections (Providers, provider editor, Profiles, profile editor, Web search, Memory, Backup, Updates) with their current order and `<details>` folding; `app.sidebar`, `app.sidebar.actions` contributions for the new-chat button, the conversation rows, rename and delete.

- [ ] **Step 1: Extract the sidebar** — split `ConversationList` into a container plus contributions; **do not put an `onClick` on a `<summary>`** (repo rule: a heading control must stay clickable independently).
- [ ] **Step 2: Extract the settings sections** — the `Section` helper becomes the kit's `Section`; each of the nine sections is registered with its existing heading and `open`-by-default value; the page's warning banners become `settings.sections` entries too, so a plugin can reorder or hide them.
- [ ] **Step 3: Browser proof** — every section folds, every control still writes the same settings key (spot-check provider protocol, model fetch, web-search toggle, memory add, backup export, update check), and rename/delete in the sidebar behave.
- [ ] **Step 4: Gates + production check.**
- [ ] **Step 5: Commit** — `refactor(ui): settings sections and sidebar as slot contributions`

---

## Phase 2 — Logic seams

### Task 10: Tools registry, tool loop rewire, `fetch_url` + `web_search` as built-in plugins

**Files:**
- Create: `web/src/lib/plugins/tools.ts`, `web/src/lib/plugins/builtin/tools/fetchUrl.ts`, `web/src/lib/plugins/builtin/tools/webSearch.ts`, `web/src/lib/plugins/builtin/tools/index.ts`
- Modify: `web/src/state/chat.ts` (delete `runTool`/`runFetch`/`runSearch`/`ToolOutcome`/`parseArguments`; the loop calls the registry), `web/src/lib/plugins/builtin/index.ts` (register tools)
- Test: `web/src/lib/plugins/tools.test.ts`

**Interfaces:**
- Consumes: Task 3's `HostServices`, Task 2's registry, `presets.ts` `FETCH_URL_NAME`/`WEB_SEARCH_NAME`, `fetch.ts` `fetchUrlText`, `tinyfish.ts` `searchWeb`/`searchResultCount`.
- Produces: `toolDeclarationSchema` / `ToolDeclaration`; `Tool` (`{ declaration, execute(input: unknown, ctx: ToolExecCtx): Effect<ToolOutcome> }`); `ToolOutcome` (`{ result, marker, failed, input }`); `resolveTool(name): Effect<Option<Tool>>`; `executeTool(name, call): Effect<ToolOutcome>`.

- [ ] **Step 1: Write the failing test** — `tools.test.ts`: a registered tool executes and its outcome reaches the loop shape; an unknown name yields `{ failed: true }` with a readable sentence and **never throws**; a duplicate name — built-in vs plugin — resolves by a stated rule (built-ins register first, a plugin's same-name tool is rejected with a `PluginFault` and the built-in wins at resolve time); the `fetch_url`/`web_search` built-ins keep their exact marker strings (`🔗 fetched <host> (<n> chars)`, `🔍 searched the web: <n> result(s)`).
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `tools.ts`** — the declaration is zod (it is serialized to the model); execution stays a TS function returning an Effect; the registry rejects a duplicate name.
- [ ] **Step 4: Move the two executors** — `runFetch`/`runSearch` bodies move into the built-in tool modules unchanged (same argument parsing, same sentences, same markers); they are now registered rather than name-dispatched.
- [ ] **Step 5: Rewire the loop** — `state/chat.ts`'s tool execution becomes `executeTool(call.name, call)`. *Spec refinement, called out deliberately:* §5 says an unknown name keeps today's fallthrough into the fetch path, but that fallthrough existed only because there were two tools and no registry; with a registry a miss is its own case and yields `"No tool named <name> is registered."` — the invariant the spec actually states (never throw out of the loop, always a string result) is preserved. Note this in the commit body.
- [ ] **Step 6: Tests → PASS**, then `tsc -b` + `lint` + `bun test`.
- [ ] **Step 7: Commit** — `feat(plugins): tool registry and built-in tools as plugins`

---

### Task 11: Providers registry, runtime protocols, and the stored-protocol migration

**Files:**
- Create: `web/src/lib/plugins/providers.ts`, `web/src/lib/plugins/builtin/providers/index.ts`
- Modify: `web/src/lib/providers/index.ts` (the static `as const` registry becomes a runtime lookup with the three built-ins pre-registered), `web/src/lib/api/index.ts` (`SendMsg` resolves through the registry), `web/src/lib/db/types.ts` (`protocol: z.enum(protocolNames)` → `z.string()`), `web/src/state/chat.ts` (protocol pruning iterates the registry), `web/src/ui/Settings.tsx` (the Protocol `<select>` and `ProviderPicker` options come from the registry)
- Test: `web/src/lib/plugins/providers.test.ts`, extend `web/src/lib/plugins/manifest.test.ts`

**Interfaces:**
- Consumes: `Provider<Send>` (unchanged), the four provider modules.
- Produces: `resolveProvider(name): Effect<Option<Provider<Send>>>`; the registry-backed `protocolNames()` and `listProtocols()`; `SendMsg` failing `"unknown protocol: <name>"` for a name no plugin provides.

- [ ] **Step 1: Write the failing test** — `providers.test.ts`: the three built-ins resolve; an unknown protocol fails as a string error, never a `TypeError` on `undefined.send`; a plugin-registered protocol resolves and `SendMsg` uses it; a duplicate name (built-in vs plugin) follows the same rule as tools.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Make the protocol field a string** — `Settings` must still parse a stored blob with any protocol value (`expect(Settings.parse({ providers: [{ id: "p", protocol: "some-plugin-thing" }] }).providers[0].protocol).toBe("some-plugin-thing")`).
- [ ] **Step 4: Implement the registry + rewire** — `SendMsg` and `state/chat.ts`'s `prevKey` pruning both go through `listProtocols()`; the Settings protocol select lists registry names.
- [ ] **Step 5: Tests → PASS**, then the full gates.
- [ ] **Step 6: Commit** — `feat(plugins): runtime provider registry and stored-protocol migration`

---

### Task 12: Pipeline registry and the six stages

**Files:**
- Create: `web/src/lib/plugins/pipeline.ts`
- Modify: `web/src/state/chat.ts` (ctx assembly, body build, stream consumption, tool execution, transcript seed, finalize)
- Test: `web/src/lib/plugins/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 2's registry (ordered entries), `providers/types.ts` (`SendCtx`, `Chunk`, `HistoryTurn`, `ToolCallData`).
- Produces: `PipelineStage<K>` per stage kind and `run<K>(kind, input, meta): Effect<Output>`; kinds: `beforeSend` (`SendCtx → Option<SendCtx>`), `transformBody` (`unknown → unknown`), `onChunk` (`Chunk → Option<Chunk>`), `afterReply` (`string → string`), `onToolCall` (`{ allow: boolean; rewrite?: ToolCallData }`), `onHistory` (`readonly HistoryTurn[] → readonly HistoryTurn[]`).

- [ ] **Step 1: Write the failing test** — `pipeline.test.ts`: stages run in `order`/`priority`/registration order; a stage that faults is logged, disabled for the session, and **skipped** (fail-open) so the turn still completes; `beforeSend` returning `Option.none()` aborts the turn; `onToolCall` `allow: false` skips execution but still appends a result the wire accepts (no orphaned `tool_call` in the replayed body); `onChunk` `Option.none()` drops the chunk and the stream still terminates; `onHistory` sees the seeded turns.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `pipeline.ts`** — ordered stages from the registry, each wrapped in `Effect.catchAllCause` → `Effect.logWarning` + a `Ref`-recorded disabled id, returning the input unchanged on fault.
- [ ] **Step 4: Wire the six call sites** — `beforeSend` where `ctx` is assembled (before the user row is appended); `transformBody` on `nextBody` and on each `buildBody(replay, …)`; `onChunk` by wrapping the stream yielded from `SendMsg` (`.pipe(Stream.mapEffect(…))`, so providers stay untouched); `onToolCall` immediately before `executeTool`; `onHistory` around `seedHistory`'s turn list; `afterReply` on the reply the finalizer appends.
- [ ] **Step 5: Tests → PASS**, then full gates.
- [ ] **Step 6: Commit** — `feat(plugins): request, stream and history pipeline stages`

---

### Task 13: Commands, keybindings and the command palette

**Files:**
- Create: `web/src/lib/plugins/commands.ts`, `web/src/ui/CommandPalette.tsx`, `web/src/ui/useGlobalKeys.ts`, `web/src/lib/plugins/builtin/commands.ts`
- Modify: `web/src/ui/slots/DefaultLayout.tsx`, `web/src/state/ui.ts` (palette state already added in Task 6)
- Test: `web/src/lib/plugins/commands.test.ts`

**Interfaces:**
- Produces: `commands.register({ id, title, run, keybinding? })`; `Command` (`{ id, title, owner, run: () => void, keybinding?: string }`); `matchKeybinding(event: KeyboardEvent): Option<string>`; `runCommand(id): Effect<void>`; built-in commands: new chat, toggle settings, toggle system prompt, stop, copy last reply, check for updates, export backup.
- Consumes: `ids.ts` (`command.palette.results`, `overlay.root`), Task 6's `state/ui.ts`.

- [ ] **Step 1: Write the failing test** — `commands.test.ts`: registration order lists deterministically; a duplicate `id` — later wins and logs a warning; a duplicate keybinding — later wins and logs; `matchKeybinding` normalises `Meta`/`Ctrl`/`Shift`/`Alt` and ignores keystrokes typed into an `<input>`/`<textarea>`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement the registry, the palette and the global handler** — the handler is attached in a scoped effect (`document.addEventListener` with a finalizer removing it), mounted by `DefaultLayout`; the palette renders into `overlay.root` and lists `command.palette.results` contributions filtered by the query.
- [ ] **Step 4: Register the built-ins** so the same actions the header buttons perform are reachable by command and keybinding.
- [ ] **Step 5: Browser proof** — open the palette with the keybinding, run "new chat", confirm a new conversation appears; type inside the composer and confirm a bare key does not fire a command.
- [ ] **Step 6: Gates + production check.**
- [ ] **Step 7: Commit** — `feat(plugins): commands, keybindings and command palette`

---

### Task 14: Settings sections registry and themes

**Files:**
- Create: `web/src/lib/plugins/settings.ts`, `web/src/lib/plugins/themes.ts`, `web/src/lib/plugins/builtin/themes/dark.ts`
- Modify: `web/src/ui/Settings.tsx` (renders `settings.sections` from the registry), `web/src/App.css` (add the `:root` variables the dark theme sets, keeping today's values as the defaults)
- Test: `web/src/lib/plugins/themes.test.ts`

**Interfaces:**
- Produces: `settings.registerSection({ id, title, order, component })`; `themes.register({ id, name, variables: Record<string,string>, css?: string })`; `applyTheme(id): Effect<void>`; `activeTheme(): Effect<Option<string>>`.
- Consumes: Task 6/9's `settings.sections` contributions.

- [ ] **Step 1: Write the failing test** — `themes.test.ts`: registering two themes and applying one sets every variable on the root element and injects its CSS once; applying a second replaces rather than stacks; unregistering the active theme restores the defaults; a theme with an unknown variable name is allowed (a theme may define new ones) but a theme id colliding with the built-in replaces it per the stated duplicate rule.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement themes** — variables are applied to `document.documentElement.style.setProperty`; `css` goes into one `<style>` element owned by the theme service, replaced on switch and removed on unregister. Honest limit per spec §4: the app's colours are Tailwind utilities, so a theme overrides what a variable or a rule reaches, and a full semantic-token refactor is out of scope.
- [ ] **Step 4: Implement the settings registry** and have `Settings.tsx` render it, with the built-in sections registered from `builtin/` (the physical moves happen in Task 9 — this task only makes the page read the registry).
- [ ] **Step 5: Browser proof** — the Settings page shows the same nine sections in the same order; switching to the built-in dark theme changes nothing visually.
- [ ] **Step 6: Gates + production check.**
- [ ] **Step 7: Commit** — `feat(plugins): settings sections registry and theme contributions`

---

### Task 15: Renderer overrides, notifications and the overlay region

**Files:**
- Create: `web/src/lib/plugins/renderers.ts`, `web/src/lib/plugins/notify.ts`, `web/src/ui/slots/Toasts.tsx`, `web/src/ui/slots/Modal.tsx`
- Modify: `web/src/ui/slots/DefaultLayout.tsx`, `web/src/ui/Message.tsx` (uses `useComponent("ui.markdown")` etc.)
- Test: `web/src/lib/plugins/notify.test.ts`

**Interfaces:**
- Produces: `renderers.register(kind, component)` for `message` | `markdown` | `marker` | `reasoning`; `notify.toast({ text, tone?, ttl? })`, `notify.banner`, `notify.confirm({ text }): Effect<boolean>`, `notify.modal({ title, content })`; the overlay region renders toasts and at most one modal at a time.
- Consumes: `overlay.root`, `state/ui.ts`.

- [ ] **Step 1: Write the failing test** — `notify.test.ts`: a toast pushes, expires after its ttl and fires a dismiss listener; a second `confirm` while one is open queues rather than replaces; a plugin's queued toasts are dropped on unload (the plugin's scope owns them).
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `notify.ts`** — a `SubscriptionRef` of overlay state, `ttl` via `Effect.delay` in a forked fiber tied to the pushing plugin's scope; `confirm`/`modal` resolve through a `Deferred`.
- [ ] **Step 4: Implement the overlay components** into `overlay.root`, reusing the kit and `ConfirmButton`'s two-step pattern.
- [ ] **Step 5: Point the renderers at the registry** — `Message.tsx` resolves markdown/marker/reasoning through `useComponent`, with the current components registered as the built-ins.
- [ ] **Step 6: Browser proof** — a plugin (fixture) raises a toast; it renders, expires, and dismissing it works; a modal traps nothing it should not.
- [ ] **Step 7: Gates + production check.**
- [ ] **Step 8: Commit** — `feat(plugins): renderer overrides, notifications and overlay region`

---

### Task 16: Host services — chat, db, storage, events, log, native stub

**Files:**
- Create: `web/src/lib/plugins/services.ts`
- Modify: `web/src/lib/plugins/host.ts` (populate the service members)
- Test: `web/src/lib/plugins/services.test.ts`

**Interfaces:**
- Produces: `host.chat` (`snapshot()`, `changes: Stream<ChatSnapshot>`, `send`, `stop`, `newConversation`, `select`, `rename`, `delete`); `host.db` (the existing `Db` adapter); `host.storage` (`get(key)`, `set(key, value)`, `delete(key)`, `keys()`, all per-plugin, persisted into `Settings.plugins[].data`); `host.on(event, handler)`; `host.log`; `host.native` (`Option<NativeHandle>`, `Option.none()` until Task 20).

- [ ] **Step 1: Write the failing test** — `services.test.ts`: storage round-trips through a fake `Db` and lands under that plugin's `plugins[].data` only; two plugins cannot read each other's keys; an event published on the `PubSub` reaches exactly the subscribers that are still loaded, and a plugin's handlers stop on unload; `host.db` is the same adapter instance the app uses.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `services.ts`** — storage writes go through the existing `setSettings` patch path (`plugins: [...]`), so `lib/backup.ts` needs no change; events are published from `state/chat.ts` at turn start, per chunk and at turn end, and from the settings/chat stores on change.
- [ ] **Step 4: Tests → PASS**, then full gates.
- [ ] **Step 5: Commit** — `feat(plugins): chat, db, scoped storage, events and log services`

---

## Phase 3 — Loader over real sources

### Task 17: Web source, module importer, globals, build preset and SDK

**Files:**
- Create: `web/src/lib/plugins/source/web.ts`, `web/src/lib/plugins/source/index.ts`, `web/src/lib/plugins/moduleImport.ts`, `web/src/lib/plugins/globals.ts`, `web/src/lib/plugins/sdk.ts`, `scripts/build-plugins.ts`
- Modify: `web/src/lib/plugins/runtime.ts` (wire the source + importer layers)
- Test: `web/src/lib/plugins/moduleImport.test.ts`

**Interfaces:**
- Produces: `PluginSource` web impl backed by an IndexedDB store (`plugins`, keyPath `id`, records `{ manifest, files: Record<string,string> }`); `importModule` (blob import in prod, direct URL import in dev); `setHostGlobals(host)`; `sdk.ts` re-exporting the API types and schema-derived types; `scripts/build-plugins.ts` building `web/plugins/<id>/` into `web/public/plugins/<id>/main.js` (gitignored).
- Consumes: Task 4's loader interfaces.

- [ ] **Step 1: Write the failing test** — `moduleImport.test.ts`: a fixture source string defines `export default { setup }` and, after import, `setup` has run against a fake host; a source with a syntax error is a `PluginLoadFailed`, not a crash; a source that imports a bare specifier fails with a message naming the no-imports contract (this is the contract from spec §6, and it should fail readably rather than mysteriously).
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement `moduleImport.ts` and `globals.ts`** — set `globalThis.__aiClient` (and the React/jsx runtime entries the preset expects) **before** `import(url)`; use `URL.createObjectURL(new Blob([source], { type: "text/javascript" }))`. Dev path: `import(/* @vite-ignore */ url)` of the built static asset.
- [ ] **Step 4: Implement the web source** — IndexedDB via `Effect.callback` (repo pattern: callback-based Web APIs need `Effect.callback`, never `new Promise`), returning manifests verbatim so invalid ones can be listed with a reason.
- [ ] **Step 5: Write `scripts/build-plugins.ts`** — Vite lib mode, `external: ["react", "react/jsx-runtime"]`, `output.globals` mapping both to the host globals, `format: "es"`, entry the plugin's `main.ts`. No new dependency.
- [ ] **Step 6: Tests → PASS**, then full gates.
- [ ] **Step 7: Commit** — `feat(plugins): web plugin source, blob importer and build preset`

---

### Task 18: Plugins section in Settings — install, enable, consent, log

**Files:**
- Create: `web/src/ui/plugins/PluginsSection.tsx`, `web/src/ui/plugins/PluginRow.tsx`, `web/src/ui/plugins/PluginLog.tsx`, `web/src/state/plugins.ts`
- Modify: `web/src/lib/plugins/builtin/ui.ts` (register the section), `web/src/lib/plugins/loader.ts`/`runtime.ts` (a public `install`/`uninstall`/`setEnabled`/`reload` surface)
- Test: `web/src/state/plugins.test.ts`

**Interfaces:**
- Produces: `state/plugins.ts` with `usePlugins(): { enabled: boolean; plugins: readonly PluginRuntimeState[] }`, `setPluginsEnabled`, `installFromText(id, files)`, `installFromUrl(url)`, `uninstall(id)`, `setPluginEnabled(id, on)`, `reload(id)`; `PluginRuntimeState` = persisted `PluginState` + `status: "loaded" | "disabled" | "failed"` + `error?: string`.
- Consumes: Tasks 1/4/17.

- [ ] **Step 1: Write the failing test** — `plugins.test.ts`: the master switch defaults off and flipping it persists; installing from text validates the manifest and refuses an invalid one with the decode detail; `setPluginEnabled(id, true)` loads and registers, `false` unloads and leaves no trace; a plugin that fails to load reports `status: "failed"` with its error and the others stay loaded.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement the surface + store** — the store mirrors `state/settings.ts` (snapshot + `useSyncExternalStore`), and the runtime actions are `runtime.runFork(...)` calls.
- [ ] **Step 4: Build the section UI** — master switch with the full-access warning text; per-plugin row (name, version, author, status, declared capabilities, enable toggle, reload, uninstall); install controls (paste source / from URL / file picker); per-plugin settings area (a contribution point so a plugin can render its own controls, using the kit); a log panel from `host.log`.
- [ ] **Step 5: Browser proof** — install the hello-world fixture from Task 19, enable it, see its contribution appear, disable it and see it disappear **without a reload**, then uninstall; with plugins disabled, confirm the app is byte-identical to today and `agent-browser errors` is clean.
- [ ] **Step 6: Gates + production check.**
- [ ] **Step 7: Commit** — `feat(plugins): plugin manager section with install, consent and log`

---

### Task 19: Example plugins and docs

**Files:**
- Create: `web/plugins/hello-world/{plugin.json,main.ts}`, `web/plugins/theme-solarized/{plugin.json,main.ts}`, `web/plugins/export-conversation/{plugin.json,main.ts}`, `web/plugins/custom-tool/{plugin.json,main.ts}`, `web/plugins/README.md`
- Modify: `web/.gitignore` (ignore `public/plugins/`), repo `AGENTS.md` (a Plugin system section: trust model, the no-imports contract, the build command, the slot map location)
- Test: browser proof per plugin

**Interfaces:**
- Consumes: the whole public API (this task is the API's acceptance test).

- [ ] **Step 1: `hello-world`** — contributes a `chat.message.actions` entry; proves slot + kit + lifecycle.
- [ ] **Step 2: `theme-solarized`** — registers and applies a theme; proves `themes` + `settings` section + persistence.
- [ ] **Step 3: `export-conversation`** — a command (`commands.register`) that reads the conversation through `host.chat` and triggers a Markdown download; declares `plugin-data` and writes a log line to its scoped data dir; proves commands, chat access and the native handle.
- [ ] **Step 4: `custom-tool`** — registers a model-callable tool; the browser proof pairs a mock model endpoint that calls the tool with a logged request body, so the executed result is evidence rather than a rendered marker.
- [ ] **Step 5: `web/plugins/README.md`** — the author's guide: manifest fields, the one-file/no-imports contract, `bun scripts/build-plugins.ts`, the API surface with a worked example per registry, and the trust warning.
- [ ] **Step 6: Update the repo `AGENTS.md`** — the plugin system's rules a future agent must not regress (the two-way trap: a plugin fault must isolate; a slot migration must be DOM-identical), compressed per the file's own rule.
- [ ] **Step 7: Commit** — `docs(plugins): example plugins and author guide`

---

## Phase 4 — Native bridge

### Task 20: Rust plugin commands, scoped data dir, Tauri source and native handle

**Files:**
- Modify: `web/src-tauri/src/lib.rs` (six commands + a scope helper), `web/src-tauri/capabilities/default.json` (new permissions)
- Create: `web/src/lib/plugins/source/tauri.ts`, `web/src/lib/plugins/native/tauri.ts`, `web/src/lib/plugins/native/web.ts`
- Modify: `web/src/lib/plugins/source/index.ts`, `web/src/lib/plugins/services.ts` (`host.native`), `web/src/ui/plugins/PluginRow.tsx` (capability consent display)
- Test: `cargo check` + browser proof on the desktop build

**Interfaces:**
- Produces: commands `plugin_list`, `plugin_read_file(id, relPath)`, `plugin_write_file(id, relPath, contents)`, `plugin_remove(id)`, `plugin_fs_read|_write|_list|_delete(id, relPath, contents?)`; the tauri `PluginSource`; `NativeHandle` with `dataDir` (read/write/list/delete) and `http`; the web `NativeHandle` as `Option.none()`.
- Consumes: Task 17's adapter selection, Task 4's loader.

- [ ] **Step 1: Implement the Rust commands** — `plugin_list` scans `<app data>/plugins/`, returning raw manifest JSON per directory; the `plugin_*_file` pair reads/writes strictly inside a plugin directory; `plugin_fs_*` share one scope helper that resolves `<app data>/plugin-data/<id>/`, **canonicalizes** the joined path and rejects anything whose canonical form does not start with the data root (symlink-safe), mirroring the existing `Result<T, String>` and `http://`/`https://` allowlist style.
- [ ] **Step 2: Add the capability entries** and run `cd web/src-tauri && cargo check --all-targets` — expected: clean (this is the only gate that catches these).
- [ ] **Step 3: Implement the tauri source + native handle**, and wire the adapter selection in `source/index.ts`/`native/` by `isDesktop` (the `lib/db` pattern).
- [ ] **Step 4: Show capability consent** — the plugin row lists declared capabilities, and the UI states plainly what is and is not a boundary: `plugin-data` is path-scoped in Rust, `net` is unenforceable, everything else is consent-only. **Do not describe any capability as a sandbox.**
- [ ] **Step 5: Browser + desktop proof** — on the desktop build, install a fixture from `<app data>/plugins/`, enable it, assert it writes into its own data dir and that a path escaping the dir (`../../settings.json`) is refused by Rust.
- [ ] **Step 6: Commit** — `feat(plugins): native bridge with scoped plugin data dir`

---

### Task 21: Hot reload

**Files:**
- Modify: `web/src-tauri/src/lib.rs` (watch `<app data>/plugins/`, emit `plugin-changed`), `web/src/lib/plugins/runtime.ts` (listen, reload the changed plugin), `web/src/ui/plugins/PluginsSection.tsx` (a manual "Reload plugins" action)
- Test: browser proof

**Interfaces:**
- Consumes: Task 20's source, Task 4's `loadPlugin`/`unloadPlugin`, Task 3's `runtime`.

- [ ] **Step 1: Emit the event** from a watcher over the plugins directory (desktop only).
- [ ] **Step 2: Reload on change** — close the changed plugin's scope, re-acquire it, and keep every other plugin loaded; a reload of a plugin whose new source is invalid leaves the old one loaded and reports the error (never a half-unloaded plugin).
- [ ] **Step 3: Manual action** — a "Reload plugins" button in the Plugins section for the web build and for the desktop case where the watcher misses an event.
- [ ] **Step 4: Browser/desktop proof** — edit a fixture's source, rebuild, confirm the change appears without restarting the app; then break the source and confirm the app survives with a clear error.
- [ ] **Step 5: Commit** — `feat(plugins): hot reload for the desktop plugins directory`

---

### Task 22: Release — minor bump, data-safety note, updater smoke check

**Files:**
- Modify: `web/src-tauri/tauri.conf.json`, `web/src-tauri/Cargo.toml`, `web/src-tauri/Cargo.lock`, `web/package.json` (all four via `bun scripts/bump-version.ts minor`), `README.md`
- Consumes: `scripts/verify-release.ts`, `.github/workflows/release-tauri.yml`

- [ ] **Step 1: Bump to the next minor** — `bun scripts/bump-version.ts minor`, then confirm all four files moved together (the version home is `tauri.conf.json`; the script rewrites the other three by text replacement).
- [ ] **Step 2: Write the release note** — what the plugin system does; that plugins are **full-trust and unsandboxed** and can read API keys and conversations; that plugins do **not** auto-update; and that **a downgrade needs a backup exported first** (spec §13: 0.2.3 has neither the safety net nor per-field tolerance).
- [ ] **Step 3: README** — a Plugins section: the master switch, installing from a folder/URL, the trust warning, and a link to `web/plugins/README.md`.
- [ ] **Step 4: Gates** — `cd web && bun test && bun run lint && bunx tsc -b && bunx vite build`, then `cd web/src-tauri && cargo check --all-targets`.
- [ ] **Step 5: Ask the user before publishing.** The release (`workflow_dispatch` with `bump = minor`, or pushing tag `desktop-v0.3.0`) needs their explicit go-ahead — never push, tag or publish without it.
- [ ] **Step 6: Verify** — after publishing, `bun scripts/verify-release.ts 0.3.0` polls and prints one verdict line (exit non-zero on any gap).
- [ ] **Step 7: Post-release smoke on real data** — on a machine with 0.2.3 installed, accept the in-app update and assert settings (providers/keys/profiles/memories) and conversations are intact afterwards. This is the one check no test in the repo can perform, and it is the whole point of Phase 0b.
- [ ] **Step 8: Commit** — `chore(release): prepare desktop v0.3.0 (plugin system)`

---

## Self-Review

**Spec coverage.** §1 zod spine → T1 (ids/manifest/state/errors/decode), T10 (`ToolDeclaration`), T11 (protocol string). §2 Host + Disposable → T3, T16. §3 Effect architecture → T2 (`Scope` registry), T3 (`Layer` + `ManagedRuntime`), T5 (bridge), T12 (stream composition), T4/T16 (`Data.TaggedError`, `PubSub`). §4 UI seams → T5–T9 (primitives, resolver, kit, slot map, migration), T14 (settings), T15 (renderers, overlay). §5 logic seams → T10 tools, T11 providers, T12 pipeline, T13 commands, T14 settings/themes, T15 renderers/notify, T16 chat/db/storage/events, T6 (`state/ui.ts` view control). §6 loader → T4, T17, T18; T19 documents the contract. §7 native → T20, T21; capability display T20 step 4. §8 data model → T1 (keys), T11 (protocol migration). §9 isolation → T4, T5, T12, T18 (`status: failed`). §10 versioning → T4 (`version.ts`), T22 (the app's minor bump, and the plugin API's separate `0.1` axis). §11 testing → T1 (wiring), every task's tests, T6–T9/T13/T15/T18/T20/T21 browser proofs. §12 phasing → the phase headers. **§13 data compatibility → T0.1 (safety net), T0.2 (`dataVersion` + migration registry + per-field tolerance + data cap), T0.3 (frozen fixtures and the downgrade assertion), T22 steps 1/2/7 (minor bump, the downgrade note, the real-data smoke).** Decisions: dogfooding is T10/T11/T13 (tools, protocols, commands) plus T14 (the dark theme), with core staying core; the "API grows rather than a built-in bypassing it" rule is exercised in T12 (stages are the API's own seam, the loop uses it).

**Gaps found and closed:** the spec's §4 mentions registry `order`/`priority` but never says where the Settings page's *banners* live — T9 puts them in `settings.sections` so they are reorderable like everything else. The spec requires a plugin to raise a confirm dialog but nothing said what resolves a `confirm` — T15's `Deferred` does. The spec's §6 dev loop needs `public/plugins/` gitignored — T19 step 1.

**Step scan.** No step decides nothing and no step is a transcript: bodies appear only where the signature and tests do not determine the code (T4's importer seam, T5's referentially-stable snapshot, T12's fail-open wrapper, T17's globals-before-import), and each of those is a stated requirement rather than code the tests already fix.

**Type consistency.** `Disposable`, `RegistryEntry`, `Registry<E>`, `Host`, `Plugin`, `PluginManifest`, `PluginState`, `ToolOutcome`, `PipelineStage<K>`, `PluginSource`, `ModuleImporter`, `LoadedPlugin`, `NativeHandle` are each defined once (T2/T3/T1/T10/T12/T4/T20) and referenced by those names everywhere after. `slotIds`/`capabilityIds`/`hostEventNames` are the only spellings of the id sets. `makeRegistry`/`makeHost`/`loadPlugin`/`unloadPlugin`/`run`/`decode` keep one name each.

**Review Focus.** 1 → T4 (setup fault, timeout) and T5 (`ContributionBoundary`), asserted again in T18's browser proof. 2 → T6–T9 browser proofs plus T18's "with plugins disabled, byte-identical". 3 → T2 duplicate id, T10 tool name, T11 protocol name. 4 → T0.1 (refused write, stored text intact), T0.2 (per-field tolerance), T0.3 (frozen fixtures + the downgrade assertion), T1 `Settings` decode, T11 stored unknown protocol. 5 → T12 fail-open, veto plus result, chunk drop with a terminating stream.

**Proportion.** The plan gives signatures, file lists and test names; only three steps carry a body. Phases are sequential and each ends green and shippable — T0.1–T0.3 make the data guarantee true before anything touches the schema, T1–T4 produce a tested subsystem, T5–T9 make the UI registry-assembled with no behaviour change, T10–T16 make every logic seam real, T17–T19 make plugins installable, T20–T21 make them native and reloadable, T22 ships it.
