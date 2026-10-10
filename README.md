# Open Source AI Client

A dark-first desktop and web client for OpenAI-compatible endpoints. Bring your own key, pick a provider and model, chat.

![The chat view: a conversation, with a collapsible thinking block above the answer](docs/screenshots/chat.png)

## Download

Prebuilt desktop builds — macOS (universal), Windows and Linux — are on [Releases](https://github.com/JeffreyJYZ/ai-client-oss/releases/latest). The same app runs as a website at [aiclient.jyz.land](https://aiclient.jyz.land).

The macOS and Windows builds are unsigned and not notarized. On macOS, right-click → Open no longer bypasses Gatekeeper — clear the download quarantine flag after installing, or the app will not open:

```sh
xattr -dr com.apple.quarantine "/Applications/oss-ai-client.app"
```

On Windows, choose **More info → Run anyway** at the SmartScreen prompt.

## Features

- Providers: OpenAI (Responses or Chat Completions), OpenRouter, OpenCode Zen, OpenCode Go, Command Code, or any OpenAI-compatible base URL.
- Streaming replies, with reasoning models' thinking in a separate collapsible block.
- Web search per endpoint: OpenAI's built-in tool, or OpenRouter's `openrouter:web_search` server tool (the model decides when to search). Endpoints with no server-side search have the toggle disabled rather than sending a tool nothing can run.
- Per-conversation system prompts, and saved profiles that bundle provider + model + prompt.
- File and image attachments.
- Everything is stored locally — IndexedDB and localStorage on the web, the app data directory in the desktop build. Export/Import moves settings and conversations between the two.

![The settings view](docs/screenshots/settings.png)

## Development

Requires [Bun](https://bun.sh) and a Rust toolchain.

```sh
cd web
bun install
bun run dev        # web only
bun run tauri dev  # desktop shell
```

Verification runs three gates: `bunx tsc -b --force`, `bunx biome check .`, and `bunx effect-language-service diagnostics --project tsconfig.app.json`.

## Layout

- `web/` — the frontend: Vite, React 19, Tailwind v4, Effect 4, zod.
- `web/src-tauri/` — the Tauri shell. Storage is a handful of Rust commands over the app data directory.

## License

MIT
