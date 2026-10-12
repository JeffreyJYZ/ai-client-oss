import { exportBackup } from "@lib/backup";
import { type CommandDefinition, registerCommand } from "@lib/plugins/commands";
import type { Host } from "@lib/plugins/host";
import { Effect } from "effect";
import { getChat, newConversation, stop } from "@/state/chat";
import {
	getUIState,
	setPalette,
	setSystemPromptOpen,
	setView,
} from "@/state/ui";
import { checkForUpdates } from "@/state/updates";
import { CommandPalette, CommandResults } from "@/ui/CommandPalette";

/**
 * The built-in commands (spec §5). **Filled by Task 13** — `builtin/index.ts`
 * already called this seam, so the shell's own actions become reachable by
 * command and keybinding without editing the shared hub.
 *
 * Every one mirrors the control it duplicates, one for one: the sidebar's
 * "+ New", the header's Settings toggle and system-prompt button, the
 * composer's Stop, and the Settings sections' update check and backup export.
 * They call the same store functions those controls call, so there is one
 * behaviour behind both entry points, never a second implementation.
 *
 * **Deliberate extra beyond the brief's list:** `app.command.palette` itself.
 * The palette has to be openable by a keybinding, and a keybinding can only
 * resolve to a command — so the palette's own toggle is a command like any
 * other, and shows up in its own list.
 *
 * Keybindings use `mod+shift+<letter>` (and plain `mod+k` for the palette)
 * because the unshifted browser shortcuts are not interceptable: a browser keeps
 * Ctrl/Cmd+N, +T and +W for itself however the page calls `preventDefault`.
 */
export const registerCommandBuiltins = (host: Host): void => {
	const toggleSettings = (): void =>
		setView(getUIState().view === "settings" ? "chat" : "settings");

	const openNewChat = (): void => {
		newConversation();
		// The sidebar button also leaves Settings for the conversation it made.
		setView("chat");
	};

	const copyLastReply = (): void => {
		const last = [...getChat().messages]
			.reverse()
			.find((message) => message.role === "assistant" && message.text !== "");
		if (last === undefined) return;
		// The clipboard write is a promise at the boundary, so it runs through
		// the same Effect seam as Settings' copy (Settings.tsx `copyBackupJson`),
		// never as a raw `.catch`.
		Effect.runFork(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(last.text),
				catch: () => undefined,
			}),
		);
	};

	/**
	 * The download half of Settings → Backup, byte-identical to it
	 * (`BackupSection.exportBackupFile`): same name pattern, same pretty-printed
	 * JSON. The import/status banner is a section-local concern and stays there.
	 */
	const exportBackupFile = (): void => {
		Effect.runFork(
			exportBackup().pipe(
				Effect.tap((backup) =>
					Effect.sync(() => {
						const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
							type: "application/json",
						});
						const url = URL.createObjectURL(blob);
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.download = `ai-client-backup-${new Date()
							.toISOString()
							.slice(0, 10)}.json`;
						anchor.click();
						URL.revokeObjectURL(url);
					}),
				),
				Effect.catch((error) =>
					Effect.logError(`failed to export a backup: ${error}`),
				),
			),
		);
	};

	const commands: readonly CommandDefinition[] = [
		{
			id: "app.command.palette",
			title: "Command palette",
			keybinding: "mod+k",
			run: () => setPalette(!getUIState().palette),
		},
		{
			id: "app.chat.new",
			title: "New chat",
			keybinding: "mod+shift+n",
			run: openNewChat,
		},
		{
			id: "app.view.settings",
			title: "Toggle settings",
			keybinding: "mod+shift+s",
			run: toggleSettings,
		},
		{
			id: "app.prompt.toggle",
			title: "Toggle system prompt",
			keybinding: "mod+shift+p",
			run: () => setSystemPromptOpen(!getUIState().systemPromptOpen),
		},
		{
			id: "app.chat.stop",
			title: "Stop streaming",
			keybinding: "mod+shift+x",
			run: stop,
		},
		{
			id: "app.reply.copy",
			title: "Copy last reply",
			keybinding: "mod+shift+c",
			run: copyLastReply,
		},
		{
			id: "app.updates.check",
			title: "Check for updates",
			keybinding: "mod+shift+u",
			run: checkForUpdates,
		},
		{
			id: "app.backup.export",
			title: "Export backup",
			keybinding: "mod+shift+e",
			run: exportBackupFile,
		},
	];

	for (const command of commands) registerCommand(host, command);

	// The palette shell goes into the overlay region (spec §4). `order` is high
	// so toasts and modals a later task contributes sit behind it, never over it.
	host.ui.register({
		id: "command.palette",
		slot: "overlay.root",
		component: CommandPalette,
		order: 100,
	});
	host.ui.register({
		id: "command.palette.results",
		slot: "command.palette.results",
		component: CommandResults,
		order: 0,
	});
};
