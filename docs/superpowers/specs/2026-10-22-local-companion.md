# Local companion — the desktop app as the website's disk and credential store

Status: implementing on `feat/local-companion`.

## Problem

`aiclient.jyz.land` is a static site. It persists settings in
`localStorage["ai-client.settings"]` and therefore holds provider API keys in the
page, cannot reach the filesystem, and cannot call endpoints that refuse the
CORS preflight (OpenCode Go). The desktop app already owns an app-data directory
(`settings.json`) and a Rust shell that makes cross-origin requests without the
webview's rules. This feature exposes that shell to the website over loopback so
one file becomes the single source of truth for settings and creds, and a
preflight-blocked provider starts working on the web.

## Non-goals

- No conversation-history sharing. Web stays on IndexedDB; desktop stays on the
  `db_*` SQLite commands. Only settings and chat transport are shared.
- No cross-device sync. Loopback only.
- No sandbox claim. The listener grants exactly what the routes below say.

## Wire contract

Base: `http://127.0.0.1:47821` (fixed; `AI_CLIENT_COMPANION_PORT` overrides for
tests). Bind `127.0.0.1` only, never `0.0.0.0`.

| route | auth | request | response |
|---|---|---|---|
| `GET /v1/ping` | no | — | `200 {"app":"ai-client","version":"<app version>","port":47821}` |
| `POST /v1/pair` | no | `{"token":"<token>"}` | `200 {"ok":true}` / `401 {"error":"bad token"}` |
| `GET /v1/settings` | yes | — | `200 <settings.json bytes>` / `404 {"error":"no settings"}` |
| `PUT /v1/settings` | yes | settings JSON | `200 {"ok":true}` / `400` on non-JSON or over the size cap |
| `POST /v1/chat` | yes | `{"url":"https://…","headers":{…},"body":"<raw>"}` | the upstream status, upstream headers minus hop-by-hop, body streamed verbatim |

Auth is `Authorization: Bearer <token>`, except `/v1/ping` and `/v1/pair` (a page
cannot present a token before it has one). A wrong or missing token is `401`;
that check runs before any body is read.

`/v1/chat` relays the upstream status and body. The page's `ChatTransport` seam
has no header field, so only the daemon's own `content-type` survives the relay
— nothing else about the upstream response is observable from the page.

`POST /v1/chat` refuses a target whose `host` is not the host of a configured
provider's `baseUrl` in the current settings, and requires `http`/`https`. That
is the SSRF bound: the route is a forwarder for configured providers, not a
general proxy.

### Browser rules (all load-bearing)

- **Origin allowlist**: exact `https://aiclient.jyz.land`; dev
  `http://localhost:5173`, `http://127.0.0.1:5173`; the app's own webview
  `tauri://localhost`. `AI_CLIENT_COMPANION_ORIGINS` (comma-separated) extends it.
  A request with an `Origin` outside that set is `403`. A request with no
  `Origin` is allowed through to the token check (a non-browser client).
- **`Host` header** must be `127.0.0.1:<port>` or `localhost:<port>`, else `403`
  — that is the DNS-rebinding guard, and `Origin` alone does not cover it.
- **Preflight** `OPTIONS` answers `204` with `Access-Control-Allow-Origin`
  (echoing the allowed origin, never `*`), `Access-Control-Allow-Methods:
  GET, POST, PUT, OPTIONS`, `Access-Control-Allow-Headers: authorization,
  content-type`, `Access-Control-Max-Age: 600` and
  `Access-Control-Allow-Private-Network: true` (Chrome's PNA preflight).
  **A preflight is credentialless and must not be treated as authentication** —
  it is answered before the token check, and the actual request still needs the
  token.
- Every non-preflight response also carries `Vary: Origin` and the same
  `Access-Control-Allow-Origin` for an allowed origin, or the page cannot read
  the body.

### Token

32 random bytes, hex, generated on first run, stored at
`<app data>/companion.json` (`{"token":"…"}`, mode `0600` on unix). Rotatable
from the desktop UI. Never logged, never echoed by `/v1/ping`.

## Desktop side (`web/src-tauri`)

- `companion.rs`: the router, the guards above, the token file, and one
  `serve(listener, state)` entry point. Started from `setup` on a fixed port; a
  bind failure is logged and the app still boots (the feature degrades to
  unavailable, it never blocks launch).
- Commands: `companion_info` → `{ port, token, running }`, `companion_rotate` →
  `{ token }`. Desktop-only UI uses them.

## Web side (`web/src`)

Files to add or touch:

- `lib/companion.ts` — probe, pair, unpair, stored token, status effect.
  - `COMPANION_PORT = 47821`
  - `COMPANION_ORIGIN = \`http://127.0.0.1:${COMPANION_PORT}\``
  - stored at `localStorage["ai-client.companion"]` as `{"token":"…"}`.
  - `companionStatus`: `GET /v1/ping` with a 600 ms `AbortSignal.timeout`;
    a failed or timed-out fetch means **absent**, never an error surfaced to the
    user. States: `absent` | `unpaired` | `paired`.
  - `pair(token)`: `POST /v1/pair`; only a `200` stores the token. `401` is a
    typed failure with a user-readable sentence.
- `lib/providers/transport.ts` — add `companionTransport(origin, token)` with
  the `ChatTransport` signature `(url, headers, body) => Effect<ChatResponse,
  string>`. It POSTs the envelope above and shapes the response **with the same
  code path `webTransport` uses** (factor that shaping into one helper; do not
  copy it). `chatTransport` becomes a dispatcher: desktop → `nativeTransport`;
  a stored token → `companionTransport`; else `webTransport`. The choice is read
  per call, so pairing takes effect without a reload. `chooseTransport` keeps
  working for its test.
- `lib/db/index.ts` — when a token is stored, settings reads and writes go to
  `GET`/`PUT /v1/settings`; every other `Db` member stays on `web`. The
  `localStorage` mirror is still written, so an unpaired reload keeps its data.
  Unpaired behaviour is byte-identical to today.
- `ui/Settings.tsx` (+ `lib/settingsSections.ts` if sections are listed there) —
  a "Local companion" section: status line, the port, a token field with
  **Pair** and **Unpair**; on desktop, the app's own token via
  `companion_info` with a **Rotate** button. Fold with the existing
  `Section`/`SubSection` kit; no `preventDefault` on a summary.

## Invariants

- **Two sources of truth must never both be live.** Paired means the daemon
  owns settings; unpaired means browser-local. If the daemon is absent while a
  token is stored, the page says so and stays on browser-local data — it does
  not silently merge.
- The page never becomes a general proxy: no route takes a path, no route reads
  arbitrary files. Settings live in one file; chat targets are provider hosts.
- Web code is Effect-only: no `async`/`await`/`throw`/`try`/`new Promise`
  (Biome GritQL gate). `Effect.tryPromise`, `Effect.callback`, `Effect.gen`.

## Verification

- Web: `cd web && bun run verify` (tsc + biome + effect-LS + bun test).
  Tests inject `fetch` — no live daemon, no port squatting.
- Desktop: `cargo test` in `web/src-tauri` for the guards, the token file, and
  one router round-trip on an ephemeral port; `cargo check --all-targets`.
