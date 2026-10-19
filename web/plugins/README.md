# Writing a plugin

An author's checklist. The **eight** plugins in this directory are worked examples — read the one that covers what you are building (the table below says which) alongside this page. `globals-proof/` is not one of them: it has no manifest and exists only to prove the build's React/JSX globals.

They **ship with the app**: `bun run build` runs `scripts/build-plugins.ts`, which writes each chunk plus `public/plugins/examples.json`, and Settings → Plugins → **Examples** installs one with a click. Installing still copies the code into your own plugins, so it is full-trust like anything else.

| Example | What it teaches |
|---|---|
| `hello-world/main.ts` | the smallest plugin: a slot contribution, the kit's `Button`, lifecycle |
| `custom-tool/main.ts` | a model-callable tool, and the `onToolCall` stage that can veto it |
| `export-conversation/main.ts` | a command, `chat.snapshot`, a native file write |
| `theme-solarized/main.ts` | a theme, a settings section, storage |
| `zen-view/main.tsx` | `ui.root.layout` (it **appends** — see §4), `host.chat.changes` through `host.run` |
| `sidebar-notes/main.tsx` | a chrome slot with real storage (`keys`/`delete`), `notify.confirm`, an event |
| `history-pipeline/main.ts` | three pipeline stages, one of which can abort a turn |
| `markdown-callouts/main.tsx` | a renderer override that delegates everything it does not handle | The generated API reference (`/docs` in the app, source `web/src/docs/reference.generated.ts`) is the authoritative signature list.

---

## 1. The manifest — `plugin.json`

| Field | Required | Notes |
|---|---|---|
| `id` | yes | One path component. Allowlist `[A-Za-z0-9._-]`, no leading/trailing `.` (mirrors Rust `safe_id`). |
| `name` | yes | Shown in the Plugins list. |
| `version` | yes | Your own version. |
| `apiVersion` | yes | The plugin API you built against — currently `0.1`. A different **major** is refused; a different minor warns. |
| `entry` | no | Defaults to `main.js`. Must match the built file's name. |
| `capabilities` | no | Declared labels: `plugin-data`, `net`, `window`, `shortcuts`, `invoke`, `fs-any`. **Consent and display only** — see §5. |
| `engines.app` | no | App-version range, e.g. `>=0.3.0`. `*` (the default) accepts anything. |
| `description`, `author`, `homepage` | no | Shown in the Plugins list. |

```json
{ "id": "acme.hello", "name": "Hello", "version": "1.0.0", "apiVersion": "0.1", "entry": "main.js" }
```

## 2. The entry file — **one pre-built ES module with no imports**

```ts
export default { setup(host) { /* register things; return void or a Disposable */ } };
```

- **Your source may import.** `react` and `react/jsx-runtime` are rewritten by the build preset onto the host's own React (so `useState` is the app's React, not a second copy). **Every other bare specifier is bundled into your file.**
- **Your output may not import anything.** The host supplies the API and React through globals, because a bundled app has no module resolver for a plugin directory. The build fails if the emitted chunk imports a bare specifier, and the loader refuses one at load time. Do not reach for `import { … } from "@lib/…"` — that is a host module: the build runs with `configFile: false` and no `@lib` alias, so it does not resolve and the build fails (were it bundled it would be a **second copy** whose module state is not the app's). The **type-only** form every example uses — `import type { Host, Tool, CommandDefinition } from "@lib/plugins/sdk"` — is erased at build time and is the supported way to get the host types.
- **The globals you get** (set immediately before your module is imported): `__aiClient` (the `Host`), `__aiClientReact`, `__aiClientJsxRuntime`. Nothing else. `import { useState } from "react"` compiles onto the second of those.
- **`main.tsx` is preferred** (JSX). `main.ts` works — use React's `createElement` then; that is what `theme-solarized/main.ts` does.
- **JSX uses the automatic runtime** — no `import React` needed for it.
- **`setup` is synchronous and must be cheap.** It is not bounded by the load timeout and cannot be preempted, so anything async belongs in an `Effect` you fork yourself. It receives one argument, `host`, and returns nothing or a `Disposable` whose `dispose` runs **first** on unload, before your registrations are collected.
- **There is no *synchronous* Effect runner on `host`.** `host.chat.send`, `host.storage.*`, `host.native.*`, `host.notify.confirm` and `host.themes.apply`/`clear`/`active` return `Effect`s. The working route is to `import { Effect, Option } from "effect"` — the preset bundles it (a second copy, ~90 kB) and it runs effects the host built with its own copy. `Effect.runSync` for a `Sync`-based read/write. **Long-lived work goes through `host.run(effect)`** (below) — its fibre is a child of your plugin's scope, so disabling the plugin stops it; never `Effect.runFork`, whose fibre belongs to nobody.
- **A provider's `buildRequest` is called more than once per turn.** The tool loop replays the turn's body as `prev` with `skipUserMessage` set, and `buildRequest` re-runs over it inside `SendMsg`. It must therefore be **idempotent under `skipUserMessage`** — building over a body that already carries the user message reproduces it unchanged. A builder that mutates shared state or appends the message again breaks the single-body invariant: the question repeats once per tool round and the sent body drifts from the stored one.
- **The build preset sets `rollupOptions.treeshake.propertyReadSideEffects: false`.** Consequence for you: reading a property is assumed side-effect free, so an unused React member you deliberately touch for its side effect would be dropped. Plain reads and function calls are unaffected; do not rely on a bare property read as a statement.

## 3. Build, install, repeat — a build loop, not an HMR loop

```sh
bun scripts/build-plugins.ts            # every web/plugins/*/main.tsx|main.ts (includes globals-proof/, a Task-17 fixture with no plugin.json — built, not installable)
bun scripts/build-plugins.ts my-plugin  # just one
```

Output: `web/public/plugins/<id>/main.js` (gitignored). Install it in the app's **Settings → Plugins** section — paste the manifest + entry source, install from a URL, or pick the files — then enable it.

**Prove against the production bundle:**

```sh
cd web && bunx vite build && bunx vite preview --port 5391
```

A pasted/installed plugin's source is imported from a `Blob`, which is the **production** path; dev (`vite dev`) imports the built asset URL instead. So an installed plugin cannot be exercised under `vite dev` — plugin development is a build-then-install loop, and the gate is `vite build && vite preview`.

## 4. The API — one worked example per registry

`Host` members split by signature: **registries register synchronously** and read as `Effect`/`Stream`; **services return `Effect`/`Stream`**.

| `host.` | Adds | Example |
|---|---|---|
| `ui.register` | a component into a named `slot` | `hello-world/main.ts`; `zen-view/main.tsx` (a full-window `ui.root.layout`) |
| `ui.kit` | the app's own primitives — `Button`, `Panel`, `Section`, `FieldRow`, `Markdown`, `cls`, and the class constants — so plugin UI matches a built-in's without copying Tailwind strings | `hello-world/main.ts`, `theme-solarized/main.ts`, `zen-view/main.tsx` |
| `commands.register` | a command (+ optional keybinding) for the palette | `export-conversation/main.ts`, `zen-view/main.tsx` |
| `settings.registerSection` | a foldable Settings section | `theme-solarized/main.ts` |
| `tools.register` | a model-callable tool (`declaration` + `execute`) | `custom-tool/main.ts` |
| `pipeline.register` | a stage: `beforeSend`, `transformBody`, `onChunk`, `afterReply`, `onToolCall`, `onHistory` | `custom-tool/main.ts` (`onToolCall`); `history-pipeline/main.ts` (`beforeSend`, `afterReply`, `onHistory`) |
| `themes.register` / `apply` / `clear` / `active` | a theme (variables + optional `css`), and apply or clear it through the app's one theme service — the same `<style>` element and `data-theme` marker the built-in uses | `theme-solarized/main.ts` |
| `providers.register` | a wire protocol (`send`/`buildRequest`/…) | host implementation (`lib/providers/chatCompletions.ts`); no plugin example |
| `renderers.register` | override `message`/`markdown`/`marker`/`reasoning` | `markdown-callouts/main.tsx` (the `markdown` kind, delegating every other document to `ui.kit.Markdown`) |
| `chat.snapshot()` | the active conversation (synchronous) | `export-conversation/main.ts`, `zen-view/main.tsx` |
| `storage.get/set/delete/keys` | your own KV, persisted in `Settings.plugins[].data` | `theme-solarized/main.ts`, `sidebar-notes/main.tsx` |
| `notify.toast/banner/modal` | host-rendered notices (synchronous) | `hello-world/main.ts`, `sidebar-notes/main.tsx` (`confirm`) |
| `native` | `Option<NativeHandle>` — `none` on web; the file members `read`/`write`/`list`/`remove`/`dataDir` are scoped to `plugin-data/<id>/` | `export-conversation/main.ts` |
| `native.http` | an unrestricted network request on the app's own `http_request` command — **not path-scoped**; it rides the `net` capability, which is **unenforceable** (§5) | — |
| `on(event, handler)` | subscribe to `turn-start`/`chunk`/`turn-end`/`conversation-changed`/`settings-changed`/`tool-called`/`plugin-loaded`/`plugin-unloaded` | `hello-world/main.ts`, `sidebar-notes/main.tsx` (`conversation-changed`) |
| `log.info/warn/error/debug` | the scoped logger, shown in the Plugins log panel | any |
| `db` | the app's own settings/conversation adapter | — |
| `version` | `{ app, api }` | `hello-world/main.ts` |

Every `register*` returns a `Disposable`; disposing removes exactly that entry. A contribution the host **refuses** yields this same inert handle: an unknown `slot` name, or a tool whose name collides with a built-in or whose `declaration`/`execute` is malformed, is dropped silently and only logged as a `PluginFault` — nothing throws, nothing renders, so a typo is invisible until you check the **Plugins log panel**. Closing your plugin's scope (disable/uninstall/reload) disposes **all** of them plus your `setup` handle — a disabled plugin must leave no trace, so retract anything you put on the document in `dispose`.

- **Long-lived work: `host.run(effect)`** — the correct way to start it. The fibre is a child of your plugin's scope, so a disable or reload interrupts it; the interruption is re-raised, while any other cause is logged as a `PluginFault`. A bare `Effect.runFork` is owned by nothing and never stops.
- **Built-ins are toggleable too — except the two locked areas.** A built-in area registers through this same API, and it is disabled the same way — the same scope close — so a contribution, a lifetime and a teardown behave identically for a built-in and for your plugin. The two exceptions are the app container (`app.substrate`) and the Plugins manager (`app.builtins`), which are the irreducible core and cannot be turned off.

### Tools on the wire

A registered tool is **announced, not merely callable**: the host reads the tools registry when it builds the outgoing request, so the moment your plugin is enabled its tool appears in the body's `tools`. Your registry entry *is* its enablement — the loader disposes it on unload, so there is no separate toggle. (The app's own `fetch_url` and client-side `web_search` are host capabilities and keep their stored settings toggle.) The body is reassembled on every tool round, so the assembly is idempotent: registering is enough — never append a declaration from a `transformBody` stage.

### Slots

The slot map is `web/src/lib/plugins/ids.ts` (`slotIds`, one `as const` tuple → schema **and** type) and is rendered on the generated reference page. A contribution renders wherever the host component puts `<Slot id="…">`; a component id (`ui.markdown`) is resolved by `useComponent`, not a slot.

- **Replacing `ui.root.layout` owns the way back.** A root layout takes over the whole app, and the host guarantees only that the Plugins manager stays *registered*, not that your layout shows it: a layout that renders no `settings.root` (the surface the manager's section renders into) shows the manager nowhere. Render a route to it yourself. That guarantee is an **area**-level one — turning off any built-in area leaves the container's surface and the manager registered — while a layout, or a per-contribution toggle that removes the route, owns that choice.

### Typing your `host`

`host.ui`, `host.ui.kit`, `host.settings`, `host.tools`, `host.renderers` and `host.themes` are typed. `host.commands`, `host.providers` and `host.pipeline` are the generic `HostRegistry<RegistryEntry>`: pass your entry as a **typed variable** (not a fresh literal) and it type-checks; the runtime stores whatever fields you put on it. The typed helpers (`registerCommand`, `registerProvider`) are host-module exports a plugin cannot reach at runtime — but `host.themes` is the typed theme service itself, so apply/clear/active are on `host`.

## 5. Trust — read this before installing anything you did not write

- A plugin is **full-trust code running in this app's process** with the app's own privileges: every provider API key, the TinyFish key, every conversation, `localStorage`, IndexedDB, the app-data directory, arbitrary network.
- **`plugin-data` is the only capability enforced for real** — the desktop command's path handling scopes it to `plugin-data/<id>/`. Through the API a plugin cannot name another plugin's directory; calling the raw command with another id is possible, and the consent UI says so.
- **`net` is unenforceable** — the webview has a global `fetch`. `window`, `shortcuts`, `invoke`, `fs-any` are **consent-only**.
- There is **no sandbox**, no untrusted tier and no CSP boundary. The `pluginsEnabled` master switch gates *loading*; nothing downstream of it limits an installed plugin.
- Capabilities are honest labels for the consent UI, not a boundary. Never describe them as a sandbox.

## 6. Limits these examples found (do not be surprised)

1. **`host.commands`/`providers`/`pipeline` are loosely typed** — the generic `HostRegistry<RegistryEntry>`, not a per-kind type (see §4). `host.ui`, `host.ui.kit`, `host.settings`, `host.tools`, `host.renderers` and the typed `host.themes` service are typed.
2. **No Effect runner** (see §2). `host.storage`, `host.chat.send`, `host.native` and `host.notify.confirm` return `Effect`s; bundle `effect` and run them yourself.
3. **Reload is two-phase, and the host owns only what you register.** A reload imports and validates the new source **first**, then closes the old instance (running its `dispose`), then runs the new `setup` — so a reload whose new source fails to import leaves the old instance running untouched, and the new `setup` runs only after the old `dispose`, so it cannot have been retracted by it. A `setup` that **throws** on reload is the one case this cannot make seamless: the old instance is already closed, so the result is *nothing* loaded (`status: "failed"`, error logged) rather than a `loaded` row over an empty registry. If you mirror state onto the page (a `data-` marker, a document class, a theme), retract it in `dispose` and re-apply it in `setup`; between the close and the new `setup` your contributions are absent for one synchronous stretch.
