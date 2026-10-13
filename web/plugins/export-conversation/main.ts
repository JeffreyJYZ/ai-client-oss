import type { CommandDefinition, Host } from "@lib/plugins/sdk";
import { Effect, Option } from "effect";

/**
 * export-conversation — a command, a chat read, and the native handle
 * (spec §5/§7).
 *
 * What it proves:
 *
 * - **`commands.register`**: the command appears in the command palette and runs
 *   from it;
 * - **chat read access**: it reads the active conversation through
 *   `host.chat.snapshot()` — a synchronous read of the app's own chat store, not
 *   a copy;
 * - **the native handle, honestly**: `host.native` is `Option.Option<NativeHandle>`,
 *   and on the web build it is **`Option.none()`** because there is no
 *   filesystem. The example checks the Option rather than assuming desktop: with
 *   a handle it writes a log line into the plugin's scoped data directory, and
 *   without one it says so and records the same fact in `host.storage` (which
 *   rides `Settings.plugins[].data`). Both halves are reachable; only the
 *   desktop one is a real file.
 *
 * **Contract notes.**
 * - `host.commands` is the bare `HostRegistry<RegistryEntry>`; the typed
 *   `registerCommand(host, definition)` helper is a host-module export a plugin
 *   cannot reach. `COMMAND` below is therefore a typed *variable* (its extra
 *   fields — `title`, `run`, `keybinding` — are permitted because it is not a
 *   fresh object literal at the call site).
 * - `host.chat.snapshot()` is synchronous by design; the *mutating* chat members
 *   (`send`, `rename`, …) return `Effect`s, which a plugin has no runner for
 *   (see the guide's runner note).
 */

const COMMAND_ID = "example.export-conversation.export";

/** A filesystem-safe file name stem for the active conversation. */
const fileStem = (title: string, id: string): string => {
	const cleaned = title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned === "" ? `conversation-${id}` : cleaned;
};

/** One message as Markdown. Errors render as a blockquote of the app's wording. */
const messageToMarkdown = (message: {
	readonly role: string;
	readonly text: string;
}): string => {
	if (message.role === "user") return `## User\n\n${message.text}\n`;
	if (message.role === "assistant") return `## Assistant\n\n${message.text}\n`;
	return `## Error\n\n> ${message.text}\n`;
};

export default {
	setup(host: Host) {
		const exportedAt = new Date().toISOString();

		const exportActive = (): void => {
			const snapshot = host.chat.snapshot();
			const conversation = snapshot.conversations.find(
				(candidate) => candidate.id === snapshot.activeId,
			);
			const title = conversation?.title ?? "Untitled";
			const markdown = [
				`# ${title}`,
				"",
				`Exported ${exportedAt} by the export-conversation plugin.`,
				"",
				...snapshot.messages.map(messageToMarkdown),
			].join("\n");

			// The download: a Blob handed to an anchor with a `download` attribute.
			// Nothing host-specific — a plugin runs in the page.
			const blob = new Blob([markdown], { type: "text/markdown" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${fileStem(title, snapshot.activeId)}.md`;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);

			const line = `${exportedAt} exported "${title}" (${snapshot.messages.length} messages, ${markdown.length} chars)`;

			// The desktop bridge is an Option. Web has no filesystem, so this branch
			// is the honest one there — and the example must not assume otherwise.
			const native = host.native;
			if (Option.isSome(native)) {
				Effect.runFork(native.value.write("export.log", `${line}\n`));
				host.log.info(`wrote the export line to the scoped data dir`);
			} else {
				Effect.runFork(
					host.storage.set("lastExport", {
						at: exportedAt,
						title,
						messages: snapshot.messages.length,
						chars: markdown.length,
					}),
				);
				host.log.warn(
					"no scoped data directory in this build (host.native is none); recorded the export in host.storage instead",
				);
			}
		};

		const command: CommandDefinition = {
			id: COMMAND_ID,
			title: "Export conversation as Markdown",
			keybinding: "mod+shift+m",
			run: exportActive,
		};

		host.commands.register(command);

		host.log.info("export-conversation loaded; command registered");
	},
};
