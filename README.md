# Open Source AI Client

Desktop and web client for OpenAI-compatible endpoints. Tauri shell, Vite + React frontend, data stored locally.

![Chat](docs/screenshots/chat.png)

## Highlights

- **Open source and copyleft**: GPL-3.0-only, so a distributed derivative must ship its source.
- **Tauri, not Electron**: the shell is Rust over the OS webview, with no bundled browser engine.
- **No bundled assets**: system fonts and inline SVG icons, so nothing but code to download.
- **One codebase, two targets**: the same app ships as a desktop binary and as a website.
- **Any OpenAI-compatible endpoint**: no vendor lock-in.
- **Local by default**: conversations and API keys stay on your machine, and the app has no analytics.

## Download

[Releases](https://github.com/JeffreyJYZ/ai-client-oss/releases/latest) publishes macOS (universal), Windows and Linux builds. The web build runs at [aiclient.jyz.land](https://aiclient.jyz.land).

The macOS and Windows builds are unsigned. On macOS, clear the download quarantine flag after installing, or the app will not open:

```sh
xattr -dr com.apple.quarantine "/Applications/oss-ai-client.app"
```

On Windows, SmartScreen warns: pick **More info → Run anyway**.

## Features

- Providers: OpenAI (Responses or Chat Completions), OpenRouter, OpenCode Zen, OpenCode Go, Command Code, Ollama, LM Studio, or any OpenAI-compatible base URL.
- Streaming, and a collapsible block for reasoning models' thinking.
- Web search where the endpoint provides it (OpenAI's built-in tool, or OpenRouter's `openrouter:web_search`).
- Per-conversation system prompts, and profiles bundling provider, model and prompt.
- File and image attachments.
- Export/Import moves settings and conversations between the desktop and web builds.

![Settings](docs/screenshots/settings.png)

## Development

Needs Bun and a Rust toolchain.

```sh
cd web
bun install
bun run dev        # web
bun run tauri dev  # desktop
```

Gates: `bunx tsc -b --force`, `bunx biome check .`, `bunx effect-language-service diagnostics --project tsconfig.app.json`.

## License

GPL-3.0-only. The 0.1.x releases were published under MIT and remain MIT.
