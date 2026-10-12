# Plugin System — Design

Status: approved in chat 2026-10-12 — awaiting spec review
Date: 2026-10-12

## Intent

Make the client completely extensible with **in-process plugins (mods)**: every UI region can be contributed to, reordered, hidden or replaced; the top-level layout can be taken over entirely; and every logic seam — model tools, wire protocols, the request/response pipeline, history, commands, settings, themes, storage, chat data, notifications — is a registry a plugin can drive.

Goal: nothing about the app's appearance or behaviour is hardcoded in a way a plugin cannot reach, and the API is typed enough (zod-derived) that a plugin author cannot silently get a shape wrong.

Secondary goal, and the reason this is worth the churn: the app's own features are re-plumbed through the same public API, so the API is proven by the app rather than by examples alone.

## Constraints

- **zod is the source of truth for types.** Anything persisted, parsed from disk, sent on the wire, or declared by a plugin is a zod schema whose TypeScript type is `z.infer`red at the definition site — never a parallel hand-written interface. Hand-written TypeScript interfaces remain only where the value is a function, an Effect or a Stream (registries, services, the host object), because zod cannot meaningfully express those.
- **Full Effect.** New code is Effect-first: services via `Context.Service` + `Layer`, lifetimes via `Scope`, state via `Ref`/`SubscriptionRef`, events via `PubSub`, errors via `Data.TaggedError`. No `async`, `await`, `throw`, `try`/`catch` or `new Promise` — inside `web/src` that is already GritQL-enforced (`biome-plugins/*.grit`), and the host lives there, so the host is Effect-clean by construction. zod results enter Effect through exactly one `decode` helper (§3).
- No new runtime dependencies: React, zod, Effect, marked, dompurify only. The plugin build preset uses Vite, which is already a dependency.
- Webview-only UI. Dark-first. **With zero plugins enabled, rendering and behaviour are identical to today.**
- Desktop and web builds both load plugins; platform differences live behind source adapters, never in the host.
- Gates stay green: biome + `@effect/language-service` + `tsc` + `vite build`, plus `bun test`.
- **Data compatibility is a hard requirement** (§13): upgrading from 0.2.3 must lose nothing and need no manual step, a stored blob that fails to parse must be preserved rather than replaced, and every schema change ships a frozen-fixture test.
- Two pieces of test wiring do not exist yet and are prerequisites: a `"test": "bun test"` script in `web/package.json`, and `"!**/*.test.ts"` appended to every Grit plugin's `includes` in `biome.jsonc` (tests legitimately use `async`/`await`).
- **Test files are typechecked, never excluded.** TypeScript 6+ needs the `@types/bun` devDependency and `"bun"` in `tsconfig.app.json`'s `types` array for `bun:test` to resolve; excluding `**/*.test.ts` from a project makes the build green by checking no test at all.

## Vocabulary

- **Plugin / mod** — one directory with a manifest and one ESM entry file, loaded into the app process.
- **Manifest** — `plugin.json`: identity, version, entry, declared capabilities.
- **Capability** — a declared permission label (e.g. `plugin-data`, `net`). A label, not a boundary (§7).
- **Contribution** — one thing a plugin adds to a registry (a slot entry, a tool, a protocol, a command, …).
- **Slot** — a named region of the UI that contributions render into.
- **Registry** — a named collection the host resolves from (slots, tools, providers, pipeline stages, …).
- **Host** — the object passed to a plugin's `setup`.
- **Pipeline** — ordered middleware stages around a model request and its streamed reply.
- **Built-in plugin** — one of the app's own features, registered through the public API at boot.
- **Source adapter** — the platform-specific way plugin files are read.

## Trust and threat model (read in full)

A plugin is **full-trust code running inside the app process with the app's own privileges**. It can read every provider API key, the TinyFish key, every stored conversation, `localStorage`, IndexedDB and the app-data directory; it can make arbitrary network calls; it can call any Tauri command the window is permitted to call. It cannot be sandboxed in process: every API boundary this design draws is advisory against a plugin that chooses to ignore it.

What the design therefore does, and does not, claim:

- A `pluginsEnabled` master switch, **default off**, gates the whole subsystem.
- Enabling it, and every install, shows the manifest's declared capabilities **plus a plain statement that plugins are unsandboxed and can read API keys and conversations**.
- Capability declarations are honest labels for consent and display, not enforcement. §7 states, per capability, what is actually enforced.
- Failure isolation **is** real and enforced (§9) — a bad plugin must never take the app down.
- There is no untrusted tier in this design, and the webview is same-origin by definition, so there is no CSP boundary either. A hosted registry would need a review and signing policy: explicitly out of scope.
- The web build has no filesystem. The same warning and consent apply; plugin source lives in IndexedDB instead of a directory.

## Architecture

Three layers plus adapters.

1. **Host core** (`web/src/lib/plugins/`) — the registries and services, the only mutable state in the subsystem, all Effect.
2. **Plugin API** — the `Host` object handed to `setup(host)`. Every `register*` returns a `Disposable` whose finalizer is attached to that plugin's `Scope`.
3. **Loader** — manifest → source text → blob module → `setup` → activate → (`reload` | dispose).

Adapters, chosen by the existing `isDesktop` probe and following the `lib/db` pattern: `PluginSource` (`source/tauri.ts` | `source/web.ts` | `source/index.ts`) and `NativeBridge` (`native/tauri.ts` | `native/web.ts`).

UI is assembled from a registry: components read slots through a `SubscriptionRef`-backed snapshot, bridged to React with `useSyncExternalStore` exactly like `state/settings.ts` and `state/chat.ts` today.

Built-in plugins register through the same API at boot, before React mounts, so the UI's first render already sees the full registry.

## §1 zod spine — types are derived, not declared twice

All in `web/src/lib/plugins/` (schemas live beside the things they describe).

| Schema | Derived type | What it is |
|---|---|---|
| `manifestSchema` | `PluginManifest` | `plugin.json`, the only thing parsed from disk |
| `pluginStateSchema` | `PluginState` | per-plugin persisted state, nested in `Settings` (§8) |
| `capabilitySchema` (`z.enum(capabilityIds)`) | `Capability` | manifest `capabilities[]` entries |
| `slotIdSchema` (`z.enum(slotIds)`) | `SlotId` | contribution targets and `ui.*` calls |
| `hostEventSchema` (`z.enum(hostEventNames)`) | `HostEvent` | `host.on(...)` event names |
| `toolDeclarationSchema` | `ToolDeclaration` | a tool's wire-name/description/JSON-Schema (serialized to the model) |
| `contributionMetaSchema` | `ContributionMeta` | a contribution's data half: `{ id, owner, slot, order, priority, hidden }` |
| `pluginSettingsSectionSchema` | `PluginSettingsSection` | a plugin's own settings metadata |
| tagged error classes | `ManifestInvalid`, `PluginLoadFailed`, `PluginFault`, `CapabilityUnknown`, `ApiVersionIncompatible` | `Data.TaggedError` in the loader/host |

`slotIds`, `capabilityIds` and `hostEventNames` are `as const` tuples, so `z.enum` gives both runtime validation **and** the union type from one declaration — adding a slot id is one line and is immediately valid in a manifest-adjacent schema.

The one existing schema this touches is `providerConfigSchema.protocol`, which stops being `z.enum(protocolNames)` and becomes `z.string()` (§8).

## §2 Host API

```ts
// web/src/lib/plugins/api.ts — the surface a plugin is compiled against.
export interface Plugin {
	readonly id: string;
	setup(host: Host): void | Disposable;
}

export interface Disposable {
	dispose(): void;
}

export interface Host {
	readonly version: { readonly app: string; readonly api: string };
	readonly ui:        UiRegistry;
	readonly commands:  CommandRegistry;
	readonly settings:  SettingsRegistry;
	readonly tools:     ToolRegistry;
	readonly providers: ProviderRegistry;
	readonly pipeline:  PipelineRegistry;
	readonly renderers: RendererRegistry;
	readonly themes:    ThemeRegistry;
	readonly chat:      ChatService;
	readonly db:        DbService;
	readonly storage:   ScopedStorage;
	readonly notify:    NotifyService;
	readonly native:    NativeHandle;
	readonly log:       Logger;
	readonly on: (event: HostEvent, handler: (payload: unknown) => void) => Disposable;
}
```

Rules that make the whole thing dispose cleanly:

- Every method that adds something returns a `Disposable`. `setup`'s return value, if any, is disposed first on unload.
- A `Disposable` is plain and synchronous for plugin authors (registering is synchronous); it closes that registration's `Scope` internally. Plugin code that wants Effect uses `host` services that return `Effect`/`Stream` (`chat`, `db`, `storage`, `pipeline` stages) — the sync/Effect split is visible in the signature, not hidden.
- `host.ui.*` calls are validated against `slotIdSchema`; an unknown slot id is a logged `PluginFault`, not a crash.

## §3 Effect architecture

- One `ManagedRuntime` for the subsystem (`web/src/lib/plugins/runtime.ts`), built from the host `Layer`s and created at boot before React mounts. `web/src` is the only caller; React components talk to it through bridges, never by running effects.
- Services: `PluginRegistry` (registrations in a `Ref`, snapshot exposed as a `SubscriptionRef`), `EventBus` (`PubSub.unbounded`), `Pipeline` (`Ref` of ordered handlers per stage), `ToolRegistry`, `ProviderRegistry`, `UiRegistry` (`SubscriptionRef`), `ThemeRegistry`, `CommandRegistry`, `SettingsRegistry`, `PluginStorage` (write-through to `Settings`), `PluginLoader`, plus the `PluginSource`/`NativeBridge` adapter services.
- **Lifetime is `Scope`.** Each plugin is `Effect.acquireRelease(load, unload)`; unload disposes that plugin's registrations in reverse order. Hot reload and disable are the same operation: close the scope, re-acquire. A disabled plugin leaves no trace without a page reload.
- **Events** are `PubSub` + `Stream.fromPubSub`, exposed as `host.on`.
- **React bridge**: `SubscriptionRef.changes` → `useSyncExternalStore`. No new state library, and the existing stores keep working.
- **Errors** are `Data.TaggedError`. Every function the host calls into plugin code is wrapped with `Effect.catchAllCause` → log + `PluginFault`; recovery uses `Effect.catchTag`.
- **Concurrency**: plugins load with bounded concurrency, each `setup` in its own fiber under its own scope, with a timeout so a setup that never returns is a load failure rather than a hung boot.
- **The zod↔Effect seam is one helper**:

```ts
const decode = <A>(schema: z.ZodType<A>, error: (detail: string) => PluginError) =>
	(u: unknown): Effect.Effect<A, PluginError> =>
		Effect.orElseFail(
			Effect.try({ try: () => schema.parse(u), catch: (cause) => String(cause) }),
			(detail) => error(detail),
		);
```

- Chunk middleware composes into the stream that already exists: `lib/providers/send.ts` pipes `Stream.mapAccum` for tool-call assembly, and pipeline `onChunk` stages are `Stream.mapEffect` returning `Option<Chunk>` — a dropped chunk is `Option.none()`. No new stream machinery.
- Outside `web/src` (fixtures, dev plugins) the Grit rules do not apply; the host never relies on that.

## §4 UI seams

Five primitives, one resolution rule, and a hard migration rule.

```ts
ui.slot(id, { component, order? });          // contribute into a region
ui.replace(componentId, Component);          // override a built-in component
ui.hide(contributionId);                     // stop a contribution rendering (still registered)
ui.order(slotId, contributionIds);           // reorder a region
ui.layout(Component);                        // take over the root layout
```

- **Resolution**: contributions to a slot render sorted by explicit `order`, then `priority`, then registration order. An entry at `ui.<componentId>` resolves to the highest-priority override, else the built-in. `hide` keeps the contribution registered so it can be unhidden.
- **The root layout is itself the default contribution to `ui.root.layout`.** One mechanism covers "add a small thing", "move everything" and "replace the whole app shell" — a plugin replacing the layout composes the same resolvable pieces in its own arrangement, or renders its own tree and ignores them.
- **Slot map** (derived from today's tree, one `slotIds` entry each): `ui.root.layout`; `app.sidebar`, `app.sidebar.actions`; `app.header`, `app.header.title`, `app.header.actions`; `app.notices`, `app.banner`; `chat.pane`, `chat.messages`, `chat.message`, `chat.message.actions`, `chat.empty`, `chat.stream-status`; `composer.root`, `composer.toolbar`, `composer.actions`; `settings.root`, `settings.nav`, `settings.sections`; `overlay.root`; `command.palette.results`.
- **Migration rule** for existing components: extract every hardcoded child into a named contribution in that file, register it, and leave behaviour untouched. `ui/App.tsx`'s header row becomes `app.header.actions` with its five children registered as built-in contributions; each `<details>` section of `ui/Settings.tsx` becomes a `settings.sections` contribution; `ui/Message.tsx` gets `chat.message.actions`; `ui/Composer.tsx` gets `composer.toolbar`/`composer.actions`; the install note and `UpdateNotice` become `app.notices` contributions; the default shell (`App.tsx`'s `<div>` tree) becomes `ui/DefaultLayout` registered at `ui.root.layout`.
- This extraction **is** the churn that buys "move everything", and it is mechanical: no behaviour changes, default render identical.
- Component kit: `ui.kit` exposes the host's own primitives (buttons, panel, `<details>` section, field row, markdown renderer) so plugin UI is visually consistent without copying Tailwind strings.
- **Theming is CSS variables + an injected stylesheet.** The app's colours are Tailwind utility classes (`bg-neutral-950`, `text-neutral-300`, `border-neutral-800`), not tokens, so a theme can restyle everything it can override with a variable or a rule, but full token-driven theming needs a separate semantic-token refactor (out of scope). The built-in dark theme becomes a contribution so the mechanism is exercised.

## §5 Logic seams

- **Tools** — `tools.register({ name, description, parameters, execute })`; the declaration is `toolDeclarationSchema` (it is sent to the model), `execute(input) => Effect<ToolOutcome>` returns `{ result, marker?, failed? }`. `state/chat.ts`'s `runTool` name-dispatch becomes a registry lookup; an unknown name keeps today's "called without a URL" failure path. The round/call budget stays host policy, exposed to plugins as an `onToolCall` veto plus a per-plugin max-calls hint.
- **Providers** — `providers.register(name, Provider<Send>)`, the existing contract unchanged. `ProtocolName` widens to `string`, `SendMsg` resolves through the registry, and an unknown protocol is a failed turn with a clear message.
- **Pipeline** — ordered stages, `priority` then registration order, **fail-open**: a stage that faults is logged, disabled for the session, and skipped; the request continues. Stage contracts:

| Stage | Signature | Semantics |
|---|---|---|
| `beforeSend` | `ctx → Effect<SendCtx \| null>` | mutate or augment the turn; `null` aborts the turn with an error row |
| `transformBody` | `(body, meta) → Effect<unknown>` | rewrite the outgoing wire body |
| `onChunk` | `(chunk, meta) → Effect<Option<Chunk>>` | rewrite or drop one streamed chunk |
| `afterReply` | `(text, meta) → Effect<string>` | inspect/rewrite the final reply before it is stored |
| `onToolCall` | `(call) → Effect<{ allow: boolean; rewrite?: ToolCallData }>` | veto or rewrite a tool call |
| `onHistory` | `(turns) → Effect<readonly HistoryTurn[]>` | transform the transcript seed |

- **Commands and keybindings** — `commands.register({ id, title, run, keybinding? })` plus a new command palette and a global key handler. Conflict resolution: later registration wins and logs a warning.
- **Settings sections** — `settings.registerSection({ id, title, order, component })`; every existing section is converted, so the Settings page is a registry rather than a fixed component.
- **Renderers** — message, markdown, marker and reasoning renderers are a specialized slot set, so a plugin can replace how code blocks render without replacing the whole message.
- **Storage** — `storage.get/set/delete` is per-plugin KV persisted inside `Settings` (§8), so it rides the existing backup; a capability-granted plugin additionally gets a scoped data directory (§7).
- **Chat/db services** — `chat` (read, subscribe, mutate conversations and messages) and `db` (settings + conversation CRUD) wrap the existing stores/adapters; nothing new is persisted by the plugin system itself except `PluginState`.
- **Notify** — `notify.toast/banner/confirm/modal`, rendered by host components into `overlay.root`, so plugin dialogs match the app and respect the `<details>`/`onClick` trap documented in AGENTS.md.
- **Memory** — `memories` read/write through `db`/settings; `memoryPrompt` composition stays core, with an `onHistory`-adjacent seam for a plugin that wants to inject its own context.

## §6 Loader

Manifest:

```json
{
	"id": "acme.export-conversation",
	"name": "Export conversation",
	"version": "1.0.0",
	"apiVersion": "0.1",
	"entry": "main.js",
	"capabilities": ["plugin-data"],
	"engines": { "app": ">=0.2.3" },
	"description": "Adds a Markdown export command.",
	"author": "Acme",
	"homepage": "https://example.com"
}
```

Steps: read `plugin.json` (`PluginSource`) → `decode(manifestSchema)` → version checks → read the entry text → register globals (`globalThis.__aiClient = host`, plus React and the jsx runtime) → `import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))` → `setup(host)` inside a scoped fiber with a timeout → activate.

**The dependency contract, and why it is this shape.** A bundled desktop app has no module resolver for a plugin directory, and a blob module cannot resolve bare specifiers. So the entry is **one pre-built ESM file with no imports** — the Obsidian model — and the host supplies React and the API through globals set before the import. Authors still write `import { React } from "@ai-client/plugin-sdk"` in source, because `scripts/build-plugins.ts` (Vite lib mode: `external: ["react", "react/jsx-runtime"]`, `output.globals` → the host globals) rewrites it. The SDK is types plus that preset; publishing it as a package is out of scope, in-repo it is `web/src/lib/plugins/sdk.ts` re-exporting the API types and the schema-derived types.

Dev loop: plugin source lives in `web/plugins/<id>/`; `scripts/build-plugins.ts` builds to `web/public/plugins/<id>/main.js` (gitignored); the loader fetches that URL in dev (Vite serves it as a static asset, so it must be pre-built too — the contract is the same in dev and prod), and reads `<app data>/plugins/<id>/` on desktop.

Failure isolation, disposal order, hot reload and version checks are §9 and §10; the loader is the only place that touches plugin source text.

## §7 Native bridge

New Rust commands, all thin, all in `web/src-tauri/src/lib.rs` alongside the existing `db_*`/`fetch_url`/`http_request`:

| Command | Purpose |
|---|---|
| `plugin_list` | scan `<app data>/plugins/`, return raw manifests (invalid ones returned verbatim for the UI to show) |
| `plugin_read_file` | read a file inside a plugin directory (entry, assets) |
| `plugin_write_file` | write a file inside a plugin directory (install/update) |
| `plugin_remove` | delete a plugin directory |
| `plugin_fs_read` / `_write` / `_list` / `_delete` | the scoped data dir, `<app data>/plugin-data/<id>/`, every path canonicalized and prefix-checked in Rust |
| watcher | emits a `plugin-changed` Tauri event so the host can hot reload |

Capabilities and what is actually enforced:

| Capability | Unlocks | Enforced? |
|---|---|---|
| `plugin-data` | scoped data dir | **Path-scoped in Rust**; the API hands the plugin a handle bound to its own id, so through the API it cannot name another plugin's directory. Not a security boundary: a plugin can call the raw command with another id — stated in the UI, not hidden. |
| `net` | nothing (informational) | **Not enforceable** — the webview has global `fetch`. |
| `window`, `shortcuts`, `invoke`, `fs-any` | (not built in v1) | **Consent-only.** |

Recorded decision: ship the honest version. A real gate needs the sandboxed tier, which this design excludes; pretending otherwise would be worse than saying so.

## §8 Data model and migrations

`Settings` (in `web/src/lib/db/types.ts`) gains:

```ts
pluginsEnabled: z.boolean().default(false),
plugins: z.array(pluginStateSchema).default([]),
// pluginStateSchema = { id, enabled, version, capabilities: string[], data: z.record(z.string(), z.unknown()) }
```

zod defaults mean an existing `settings.json`/`localStorage` blob parses unchanged — no migration code. `data` carries plugin-owned storage, so `lib/backup.ts` needs no change.

The one breaking change: `providerConfigSchema.protocol` is `z.enum(protocolNames)` today and becomes `z.string()`, because a registry cannot be enumerated at schema-definition time. Touchpoints: `lib/db/types.ts`, `state/chat.ts` (`prevKey` pruning iterates `protocolNames` — switch to the registry's keys or a seen-protocol set), `state/settings.ts`. A stored protocol no plugin provides resolves to a failed turn with a readable message, never a crash.

Directories: `<app data>/plugins/<id>/` (source) and `<app data>/plugin-data/<id>/` (scoped data).

## §9 Failure isolation and errors

| Failure | Behaviour |
|---|---|
| Invalid manifest | listed, disabled, reason shown in the Plugins section |
| Load failure (read/decode/import) | same, with the error text |
| `setup` faults | logged, plugin disabled, app unaffected |
| `setup` never returns | timeout → treated as load failure |
| Registration fault (unknown slot, bad schema) | that registration dropped, plugin keeps running |
| Contribution render fault | React error boundary per contribution; the slot renders a fallback, the rest of the app lives |
| Pipeline stage fault | logged, stage disabled for the session, request continues (fail-open) |
| Repeated faults | auto-disable with a Settings notice and a plugin log panel |

The app must never white-screen because of a plugin. Per AGENTS.md, a blank page is verified with `agent-browser errors` plus `document.getElementById("root")?.children.length`, not by inference.

## §10 Compatibility and versioning

`apiVersion` is semver-checked by the loader: a different major is refused with a clear reason, a different minor warns and loads. `engines.app` is checked against the Tauri app version. Within a major, the API only gains; removals bump the major. The SDK's types are versioned with the app so a plugin author can pin the app version they built against.

Two axes, deliberately separate. The **app** version for this change is a **minor** (`0.3.0`): a user-facing feature with no data-format break (§13), and therefore no manual step for users. The **plugin API** starts at `0.1` and is unstable by declaration — which is exactly why the loader refuses a different major instead of pretending compatibility. A plugin built against `0.1` must be rebuilt when the API's major moves; the loader's refusal is a clear message, not a crash.

## §11 Testing and verification

- **Wiring**: add `"test": "bun test"` to `web/package.json`; append `"!**/*.test.ts"` to each Grit plugin's `includes` in `biome.jsonc`.
- **Unit** (`web/src/lib/plugins/*.test.ts`): registry register/dispose/priority/override resolution; pipeline order, fail-open, veto, chunk drop; manifest decode (valid, invalid, missing, extra, bad `apiVersion`); loader blob-import of a fixture module, setup fault → auto-disable; slot resolution (hide, replace, order, layout); `Settings` decode with the string protocol.
- **Integration**: one fixture plugin registering one of everything, asserted through the registries rather than the DOM.
- **Browser proof** (the AGENTS.md recipe — override `window.fetch` for the mock host only, seed `localStorage["ai-client.settings"]`, log request bodies): enable a fixture plugin in dev and assert a slot entry renders, a registered tool actually executes, a theme variable applies, a plugin throw leaves the app alive, and `agent-browser errors` is clean. Then repeat the loader check against the production bundle (`vite build && vite preview`) — dev serves unbundled ESM and cannot catch bundling faults.
- **Gates**: `bun test`, `biome check .`, effect-LS diagnostics, `tsc`, `vite build`.

## §12 Phasing

Each phase leaves the app working; nothing is half-wired between phases.

0. **Spine** — `api.ts` + `ids.ts` (zod tuples) + `manifestSchema` + `pluginStateSchema` + registry/`Scope` primitive + `runtime.ts` + `Settings` keys + `bun test` wiring + unit tests.
1. **UI seams** — `Slot`/`useSlot`/`useComponent` + resolution + component kit; migrate every component in `web/src/ui/` to the slot map; default shell becomes `ui.root.layout`'s contribution. No behaviour change.
2. **Logic seams** — tools, providers, pipeline, commands + keybindings + palette, settings sections, renderers, themes, storage, notify, chat/db services. Existing features register as built-in plugins as each seam lands.
3. **Loader** — source adapters (tauri/web), blob import, lifecycle/hot reload, manifest decode, Plugins section in Settings (install, enable, capabilities, per-plugin settings, log), `scripts/build-plugins.ts`, example plugins.
4. **Native bridge** — the Rust commands, capability display/consent, scoped data dir, watcher, docs.
5. **Deferred** — hosted registry/marketplace, zip import, the sandboxed tier, semantic theme tokens.

Subagent routing: phase 1's mechanical seam conversion and the fixtures are free-model subagent work; the registry, `Scope` lifetime, loader, pipeline and native-bridge work is review-class work. Every phase keeps `tsc` + gates green and names the seam it adds, not just the file.

## §13 Data compatibility, migration and rollout

- **The promise.** Upgrading must not lose or hide user data and must not require a manual step. The `protocol` field widening to `z.string()` and the two new `Settings` keys are additive (zod defaults), and no conversation field changes — so a 0.2.3 install's data loads as-is. That claim is only true once the parse-failure path stops destroying data (next bullet).
- **The hazard this change would otherwise exercise.** `Db.getSettings` returns `settingsDefaults()` when the stored blob fails `Settings.safeParse` (`db/tauri.ts:65-75`, `db/web.ts:103-115`), and `Db.setSettings` re-reads through that same path and writes the merged result (`db/tauri.ts:77-85`, `db/web.ts:117-128`). One schema regression therefore becomes a **silent wipe**: providers, API keys, profiles and memories are replaced by defaults on the next settings write — a notice dismissal is enough — with no error shown and no copy kept. This is a pre-existing hazard; a schema change is what makes it likely, so this change fixes it rather than inherit it.
- **Safety net (required, not optional).** On a parse failure the adapters must: leave the stored blob untouched; expose the raw value (`Db.rejectedSettings(): Effect<Option<string>>`) so the UI can offer it; refuse to write (`Db.setSettings` fails with a readable reason) until the user explicitly resets; and let the app run on in-memory defaults meanwhile. `Db.resetRejectedSettings(): Effect<void>` is the explicit escape hatch. No sidecar file and no new Rust command is needed: on desktop the original `settings.json` is simply never overwritten, and on web the `localStorage` value stays as written.
- **Tolerance per field.** A field a plugin can write takes a per-field fallback (defaulted then caught) so one bad value degrades that field instead of failing the whole object — a whole-object failure is what triggers the defaults path, so this is the difference between one broken provider and every provider gone.
- **Migrations.** `Settings` gains `dataVersion: z.number().default(1)` plus a migration registry: ordered, pure, idempotent `(settings) => settings` functions applied when a stored blob's `dataVersion` is below the current one. v0.3.0 ships the registry with **no** migrations — the machinery is what is missing and the next schema change is what will need it. Before any migration runs, the app writes a pre-migration backup through the existing `exportBackup` path.
- **Downgrade is not compatible, and cannot be made so.** A 0.2.3 build reading a blob that names a plugin protocol fails the whole object (the `z.enum` on one provider) and would default-and-wipe; 0.2.3 has neither the safety net nor per-field tolerance. New keys read by an older build are stripped by zod rather than rejected, so an old build loses plugin state and no core data. The release note must therefore say: export a backup before downgrading.
- **Backups both directions.** An old backup has no `plugins` key (defaulted); a new backup read by an older build keeps everything except plugin keys. `BACKUP_VERSION` stays `1` — it moves only with a change to the envelope's shape, and that bump fails loudly on the old side (`z.literal`) instead of silently. Import routes through the guarded `setSettings` (§13's safety net), so while an unreadable blob is outstanding the guard refuses the import with the same message — the user must Reset settings first, then import. That is deliberate (refusing beats overwriting), and the message says so.
- **Conversations.** Their shape is unchanged, and both adapters silently drop an unparseable row (`db/tauri.ts:34-48`, `db/web.ts:76-84`) — a dropped row is invisible but still on disk, so it is recoverable. A frozen conversation fixture pins this, and the rule for future changes is: never narrow a field, never add a required one.
- **Plugin-owned data.** A full-trust plugin can write arbitrary bytes into `Settings.plugins[].data`, which rides `settings.json` and every backup. Cap it per plugin, so one plugin cannot balloon the settings file to unusable size.
- **Rollout.** A **minor** release (`0.3.0`). The in-app updater (present since 0.1.2, signed, driven by `release-tauri.yml` → `desktop-v*` + `latest.json`) delivers it automatically to installed 0.1.2+ builds — which is precisely why the guarantee above is load-bearing at release time, since there is no post-hoc rollback for data. Users on 0.1.0/0.1.1 have no updater and install by hand. The Homebrew cask sets `auto_updates true`, so it will not replace a self-updated app. **Plugins do not auto-update** — no registry exists in this design; a plugin is updated by reinstalling it or through the directory hot reload, and a plugin built against a different `apiVersion` major is refused with a clear message.
- **Pre-release gate.** A committed fixture set run by `bun test`: a real 0.2.3 settings blob, conversation JSON and backup parse unchanged; the current schema round-trips a blob carrying a plugin protocol, plugin state and `dataVersion`; and a deliberately corrupted blob leaves the stored value intact while `setSettings` refuses.

## Decisions

- **Data compatibility is a hard requirement** (§13), which is what keeps this change a minor release: the schema change is additive, no conversation field moves, and the parse-failure path is fixed to preserve rather than replace. The migration registry ships empty because the next schema change is what needs it.
- **Plugin code has no auto-update** (no registry in this design); the app itself does auto-update, and therefore reaches real user data — which is why §13 is a gate rather than a note.
- **Full-trust in-process plugins** (user's call). Only model that delivers "modify all UI, move everything, control all logic"; no in-process sandbox exists, so none is claimed.
- **Local directory now, hosted registry later** (user's call). The loader reads a manifest and a source adapter, so nothing in the API assumes a local directory.
- **Slots + replace/hide/order + layout override** (user's call), with the registry-assembled UI and the default layout as a contribution.
- **All logic seams in v1** (user's call).
- **Webview + capability-gated native bridge** (user's call), where "gated" means the API's shape, with enforcement stated honestly per capability (§7).
- **Dogfood everything that can be** (user's call): tools, protocols, settings sections, renderers, themes and commands become built-in plugins. Core stays core — `db`, the updater, platform probes, the conversation store and the host itself. Built-ins register through the same public API; where a built-in needs an internal the API does not expose, **the API grows** rather than the built-in bypassing it. The escape hatch exists but is a last resort, justified per case in the plan.
- **zod-first types, full Effect** (user's call): schemas are the source of truth, `Data.TaggedError` for the subsystem's errors, `Scope` for lifetime, `SubscriptionRef`/`PubSub` for state and events.
- **No new runtime dependencies**; zip import and the SDK's publication are deferred.
- **Light/dark**: theming is a contribution; the built-in dark theme is one, so the seam is exercised rather than theoretical.

## Success criteria

- With zero plugins enabled, the app renders and behaves exactly as today.
- A plugin can add/remove/reorder/replace any listed region, replace the root layout, register a tool that executes in the loop, register a protocol, rewrite an outgoing request, rewrite or drop a streamed chunk, add a command and keybinding, add a settings section, set theme variables, raise a toast, read and write conversations, and write to its own data directory.
- Disabling a plugin removes every trace of it without a page reload.
- An invalid manifest, a load fault, a setup fault, a render fault and a middleware fault each leave the app alive and visible.
- Upgrading from a 0.2.3 install loses nothing and needs no manual step; a corrupted settings blob is preserved and reported, and is never silently replaced by defaults.
- `bun test`, `bun run lint`, `tsc` and `vite build` are green.

## Out of scope

- A hosted registry/marketplace, plugin signing, review policy, plugin auto-update.
- The sandboxed/untrusted tier (worker or iframe plus a message protocol).
- Zip/asset-bundle import; multi-file plugins (the entry must be one file).
- A semantic design-token refactor of the Tailwind class strings.
- Per-plugin dependency bundling or npm resolution inside plugins.
- Native filesystem beyond the scoped plugin directory; window control and global shortcuts (declared, not built).

## Self-review

- **Placeholders:** none. Two deliberate "at implementation time" details are named with their target: the exact Vite preset options for the plugin build, and the watcher crate/approach for `plugin-changed` — both are one-file decisions with a stated contract.
- **Consistency:** the capability table (§7) matches the trust section (no claimed boundary); the slot map (§4) matches the migration rule; `pluginStateSchema` (§8) is the same object referenced in §1; the pipeline stages (§5) are the same list the phasing (§12) implements.
- **Scope:** large but single-threaded — one subsystem, phased, with phases 0–2 shippable without the loader. Big enough that the plan must sequence phases, not parallelize them.
- **Ambiguity:** "gated" is defined as API shape, not enforcement, in three places; "identical to today" is defined as the same components with the same props rendering the same children in the same order.
