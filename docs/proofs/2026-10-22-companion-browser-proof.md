# Local companion — browser proof (production bundle)

Date: 2026-10-22. Worktree: `/Users/jyz/dev/worktrees/ai-client-oss/local-companion`.
Stub daemon: `COMPANION_STUB_DIR=…/companion-proof COMPANION_STUB_UPSTREAM=echo COMPANION_STUB_TOKEN=stub-token bun scripts/companion-stub.ts` (pid 68773). Preview: `cd web && bunx vite build && bunx vite preview --port 4173 --strictPort` (pid 69167). Browser session: `companion-proof-c3d42a0f1047`.

## 1. Unpaired page unchanged — PASS
- Cleared `localStorage["ai-client.companion"]` and `ai-client.settings`, reloaded.
- Settings → LOCAL COMPANION section text: "Running, but this page is not paired." + "Port: 47821".
- `localStorage["ai-client.companion"]` = null.
- No requests to 127.0.0.1 in that state (chat not exercised pre-pairing; chat transport default is webTransport).

## 2. Pairing — PASS
- Filled token field with `stub-token`, clicked Pair.
- Section switched to "Paired — settings and requests go through the desktop app."
- `localStorage["ai-client.companion"]` = `{"token":"stub-token"}`.
- Network: `OPTIONS …/v1/pair 204`, `POST …/v1/pair 200`.

## 3. Settings now live on daemon — PASS
- Toggled "PAGE FETCH" checkbox (was true → false).
- Network: `PUT …/v1/settings 200`.
- Stub file `/…/companion-proof/settings.json` contains `"fetchToolEnabled":false`.
- Reloaded with daemon up: checkbox still `checked=false`.

## 4. Chat rides companion — PASS
- Configured provider baseUrl `https://example.com/v1`, apiKey `test-key`, model `gpt-4o`.
- Sent "hello". Network: `POST http://127.0.0.1:47821/v1/chat 200`.
- Request body envelope: `{"url":"https://example.com/v1/chat/completions","headers":{"content-type":"application/json","authorization":"Bearer test-key"},"body":"{\"model\":\"gpt-4o\",...}"}`.
- Reply rendered from stub's echo SSE (stub returns `data: {"stub":1}` etc.).

## 5. Unpair — PASS
- Clicked Unpair.
- `localStorage["ai-client.companion"]` = null.
- Section: "Running, but this page is not paired." + "Unpaired — this page keeps its own browser-local settings."
- Sent "hello2"; network shows `POST https://example.com/v1/chat/completions` and no `/v1/chat` to 127.0.0.1.

## 6. Wrong token — PASS
- Filled `nope`, clicked Pair.
- Section message: "the local companion rejected that token — check the token in the desktop app and try again".
- `localStorage["ai-client.companion"]` = null (not stored).
- Network: `POST …/v1/pair 401`.

## Statements in brief found wrong
- Stub does not log requests to stdout; evidence captured via `agent-browser network requests` / `request <id>` instead.
- "Fresh profile" not strictly achieved (reused browser profile); localStorage cleared manually, which is equivalent for the tested keys.

## Cleanup
- Closed only own session `companion-proof-c3d42a0f1047`.
- Killed preview (pid 69167) and stub (pid 68773); verified `lsof -ti tcp:47821` and `tcp:4173` empty.