# Writing a plugin

An author's checklist. The four plugins in this directory are the worked
examples; read one alongside this page. The generated API reference
(`/docs` in the app, source `web/src/docs/reference.generated.ts`) is the
authoritative signature list.

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
| `engines.app` | no | App-version range, e.g. `>=0.2.3`. `*` (the default) accepts anything. |
| `description`, `author`, `homepage` | no | Shown in the Plugins list. |

```json
{ "id": "acme.hello", "name": "Hello", "version": "1.0.0", "apiVersion": "0.1", "entry": "main.js" }
```

## 2. The entry file — **one pre-built ES module with no imports**

```ts
export default { setup(host) { /* register things; return void or a Disposable */ } };
```

- **Your source may import.** `react` and `react/jsx-runtime` are rewritten by
  the build preset onto the host's own React (so `useState` is the app's React,
  not a second copy). **Every other bare specifier is bundled into your file.**
- **Your output may not import anything.** The host supplies the API and React
  through globals, because a bundled app has no module resolver for a plugin
  directory. The build fails if the emitted chunk imports a bare specifier, and
  the loader refuses one at load time. Do not reach for `import "@lib/..."`
  — that is a host module, resolved only if it happens to be bundled, and it
  would be a **second copy** whose module state is not the app's.
- **The globals you get** (set immediately before your module is imported):
  `__aiClient` (the `Host`), `__aiClientReact`, `__aiClientJsxRuntime`. Nothing
  else. `import { useState } from "react"` compiles onto the second of those.
- **`main.tsx` is preferred** (JSX). `main.ts` works — use React's
  `createElement` then; that is what `theme-solarized/main.ts` does.
- **JSX uses the automatic runtime** — no `import React` needed for it.
- **`setup` is synchronous and must be cheap.** It is not bounded by the load
  timeout and cannot be preempted, so anything async belongs in an `Effect` you
  fork yourself. It receives one argument, `host`, and returns nothing or a
  `Disposable` whose `dispose` runs **first** on unload, before your
  registrations are collected.
- **There is no Effect runner on `host`.** `host.chat.send`,
  `host.storage.*`, `host.native.*` and `host.notify.confirm` return `Effect`s.
  The working route is to `import { Effect, Option } from "effect"` — the preset
  bundles it (a second copy, ~90 kB) and it runs effects the host built with its
  own copy. `Effect.runSync` for a `Sync`-based read/write, `Effect.runFork` to
  fire and forget. Reach for a host Effect only when you need one.
- **A provider's `buildRequest` is called more than once per turn.** The tool
  loop replays the turn's body as `prev` with `skipUserMessage` set, and
  `buildRequest` re-runs over it inside `SendMsg`. It must therefore be
  **idempotent under `skipUserMessage`** — building over a body that already
  carries the user message reproduces it unchanged. A builder that mutates
  shared state or appends the message again breaks the single-body invariant:
  the question repeats once per tool round and the sent body drifts from the
  stored one.
- **The build preset sets `rollupOptions.treeshake.propertyReadSideEffects: false`.**
  Consequence for you: reading a property is assumed side-effect free, so an
  unused React member you deliberately touch for its side effect would be
  dropped. Plain reads and function calls are unaffected; do not rely on a bare
  property read as a statement.

## 3. Build, install, repeat — a build loop, not an HMR loop

```sh
bun scripts/build-plugins.ts            # every web/plugins/*/main.tsx|main.ts
bun scripts/build-plugins.ts my-plugin  # just one
```

Output: `web/public/plugins/<id>/main.js` (gitignored). Install it in the app's
**Settings → Plugins** section — paste the manifest + entry source, install
from a URL, or pick the files — then enable it.

**Prove against the production bundle:**

```sh
cd web && bunx vite build && bunx vite preview --port 5391
```

A pasted/installed plugin's source is imported from a `Blob`, which is the
**production** path; dev (`vite dev`) imports the built asset URL instead. So an
installed plugin cannot be exercised under `vite dev` — plugin development is a
build-then-install loop, and the gate is `vite build && vite preview`.

## 4. The API — one worked example per registry

`Host` members split by signature: **registries register synchronously** and
read as `Effect`/`Stream`; **services return `Effect`/`Stream`**.

| `host.` | Adds | Example |
|---|---|---|
| `ui.register` | a component into a named `slot` | `hello-world/main.ts` |
| `commands.register` | a command (+ optional keybinding) for the palette | `export-conversation/main.ts` |
| `settings.registerSection` | a foldable Settings section | `theme-solarized/main.ts` |
| `tools.register` | a model-callable tool (`declaration` + `execute`) | `custom-tool/main.ts` |
| `pipeline.register` | a stage: `beforeSend`, `transformBody`, `onChunk`, `afterReply`, `onToolCall`, `onHistory` | `custom-tool/main.ts` (`onToolCall`) |
| `themes.register` | a theme (variables + optional `css`) | `theme-solarized/main.ts` |
| `providers.register` | a wire protocol (`send`/`buildRequest`/…) | see `lib/providers/chatCompletions.ts` |
| `renderers.register` | override `message`/`markdown`/`marker`/`reasoning` | `lib/plugins/renderers.ts` |
| `chat.snapshot()` | the active conversation (synchronous) | `export-conversation/main.ts` |
| `storage.get/set/keys` | your own KV, persisted in `Settings.plugins[].data` | `theme-solarized/main.ts` |
| `notify.toast/banner/modal` | host-rendered notices (synchronous) | `hello-world/main.ts` |
| `native` | `Option<NativeHandle>` — `none` on web; `write`/`read`/`list`/`http` scoped to `plugin-data/<id>/` | `export-conversation/main.ts` |
| `on(event, handler)` | subscribe to `turn-start`/`chunk`/`turn-end`/`conversation-changed`/`settings-changed`/`tool-called`/`plugin-loaded`/`plugin-unloaded` | `hello-world/main.ts` |
| `log.info/warn/error/debug` | the scoped logger, shown in the Plugins log panel | any |
| `db` | the app's own settings/conversation adapter | — |
| `version` | `{ app, api }` | `hello-world/main.ts` |

Every `register*` returns a `Disposable`; disposing removes exactly that entry.
Closing your plugin's scope (disable/uninstall/reload) disposes **all** of them
plus your `setup` handle — a disabled plugin must leave no trace, so retract
anything you put on the document in `dispose`.

### Slots

The slot map is `web/src/lib/plugins/ids.ts` (`slotIds`, one `as const` tuple →
schema **and** type) and is rendered on the generated reference page. A
contribution renders wherever the host component puts `<Slot id="…">`; a
component id (`ui.markdown`) is resolved by `useComponent`, not a slot.

### Typing your `host`

`host.ui`, `host.settings`, `host.tools` and `host.renderers` are typed.
`host.commands`, `host.themes`, `host.providers` and `host.pipeline` are the
generic `HostRegistry<RegistryEntry>`: pass your entry as a **typed variable**
(not a fresh literal) and it type-checks; the runtime stores whatever fields you
put on it. The typed helpers (`registerCommand`, `makeThemeService`,
`registerProvider`) are host-module exports a plugin cannot reach at runtime.

## 5. Trust — read this before installing anything you did not write

- A plugin is **full-trust code running in this app's process** with the app's
  own privileges: every provider API key, the TinyFish key, every conversation,
  `localStorage`, IndexedDB, the app-data directory, arbitrary network.
- **`plugin-data` is the only capability enforced for real** — the desktop
  command's path handling scopes it to `plugin-data/<id>/`. Through the API a
  plugin cannot name another plugin's directory; calling the raw command with
  another id is possible, and the consent UI says so.
- **`net` is unenforceable** — the webview has a global `fetch`. `window`,
  `shortcuts`, `invoke`, `fs-any` are **consent-only**.
- There is **no sandbox**, no untrusted tier and no CSP boundary. The
  `pluginsEnabled` master switch gates *loading*; nothing downstream of it
  limits an installed plugin.
- Capabilities are honest labels for the consent UI, not a boundary. Never
  describe them as a sandbox.

## 6. Gaps these examples found (do not be surprised)

1. **No component kit on `Host`.** Spec §4 promises `ui.kit` (buttons, panel,
   `<details>` section, field row, markdown). It is not exposed — copy the
   neutral Tailwind classes by hand.
2. **A theme can be registered but not applied.** `host.themes` has no `apply`,
   and `applyTheme(id)` / `activeTheme()` are host-module exports a plugin
   cannot reach. Applying a theme means writing the variables yourself.
3. **`host.commands`/`themes`/`providers`/`pipeline` are untyped** (see §4).
4. **A registered tool is never declared to the model.** The wire `tools` array
   is built from host policy plus the provider's stored toggle; the tools
   registry is not consulted, and a `transformBody` stage is overwritten by
   `buildRequest` before the request goes out. The tool is *executable* when the
   model calls it, not *announceable*.
5. **No Effect runner** (see §2). Bundle `effect` if you need one.
6. **A plugin's `dispose` can run after a reload's `setup`.** Clicking
   **Reload** can leave a plugin's mirrored document state retracted even though
   the plugin is reported loaded and its persisted setting says otherwise; a
   plain page reload is unaffected. Re-apply defensively if you mirror state.
