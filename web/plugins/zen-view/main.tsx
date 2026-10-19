import type { ChatSnapshot, CommandDefinition, Host } from "@lib/plugins/sdk";
import { Effect, Stream } from "effect";
import { useEffect, useState } from "react";

/**
 * zen-view — owning the whole window (spec §4).
 *
 * What it teaches:
 *
 * - **`ui.root.layout`**: `Slot` renders *every* contribution to a slot, so a
 *   second root layout renders *alongside* `DefaultLayout` — nothing is
 *   replaced. The only way to "take over" the window is to cover the shell
 *   visually, which is what this example does with a fixed full-viewport
 *   surface (`fixed inset-0 z-50 bg-neutral-950`). `ui/App.tsx`'s comment
 *   says a plugin "can replace the whole shell"; the truth is append, and
 *   replacement is only visual — this example shows how.
 * - **`host.chat.snapshot()` / `host.chat.changes`**: reads the live chat
 *   store and follows it, rendering the active conversation's messages.
 * - **`host.run`**: the subscription is forked into this plugin's `Scope`, so
 *   disabling the plugin interrupts it. `Effect.runFork` would outlive the
 *   plugin — the leak this example exists to prevent. `host.run` and not
 *   `Effect.runFork`, because the scope is the lifetime.
 * - **kit beyond `Button`**: `Panel`, `Section`, `Markdown`.
 *
 * What it deliberately does not do: send messages, mutate chat, or persist
 * anything. It is a read-only overlay.
 *
 * Opened by the registered command "Open Zen view" (keybinding `mod+shift+z`),
 * closed by Escape.
 */

const COMMAND_ID = "example.zen-view.open";

// Module-level open state, shared between the command and the component.
let open = false;
const openListeners = new Set<(value: boolean) => void>();
const setOpen = (value: boolean): void => {
	open = value;
	for (const listener of openListeners) listener(value);
};

// Module-level chat snapshot, updated by the host.run subscription.
let chatSnapshot: ChatSnapshot | null = null;
const chatListeners = new Set<(snapshot: ChatSnapshot) => void>();

export default {
	setup(host: Host) {
		const { Panel, Section, Markdown } = host.ui.kit;

		// Seed and follow the chat store through host.run, so the subscription is
		// owned by this plugin's Scope and interrupted on unload.
		chatSnapshot = host.chat.snapshot();
		host.run(
			Stream.runForEach(host.chat.changes, (snapshot) =>
				Effect.sync(() => {
					chatSnapshot = snapshot;
					for (const listener of chatListeners) listener(snapshot);
				}),
			),
		);

		const command: CommandDefinition = {
			id: COMMAND_ID,
			title: "Open Zen view",
			keybinding: "mod+shift+z",
			run: () => setOpen(true),
		};
		host.commands.register(command);

		function ZenView() {
			const [isOpen, setIsOpen] = useState(open);
			const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(
				chatSnapshot,
			);

			useEffect(() => {
				const onOpen = (value: boolean): void => setIsOpen(value);
				openListeners.add(onOpen);
				setIsOpen(open);
				return () => {
					openListeners.delete(onOpen);
				};
			}, []);

			useEffect(() => {
				const onChat = (value: ChatSnapshot): void => setSnapshot(value);
				chatListeners.add(onChat);
				setSnapshot(chatSnapshot);
				return () => {
					chatListeners.delete(onChat);
				};
			}, []);

			useEffect(() => {
				if (!isOpen) return;
				const onKeyDown = (event: KeyboardEvent): void => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [isOpen]);

			if (!isOpen) return null;

			const activeTitle =
				snapshot?.conversations.find(
					(candidate) => candidate.id === snapshot.activeId,
				)?.title ?? "No conversation";

			return (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950 p-6">
					<div className="w-full max-w-2xl">
						<Panel>
							<Section heading="Zen view" open>
								<p className="text-sm text-neutral-300">
									A fixed full-viewport surface layered over the app's shell.
									Press Escape to close.
								</p>
								<Markdown
									text={`**Conversation:** ${activeTitle}\n\n${snapshot?.messages.length ?? 0} messages.`}
								/>
							</Section>
						</Panel>
					</div>
				</div>
			);
		}

		host.ui.register({
			id: "example.zen-view.layout",
			slot: "ui.root.layout",
			component: ZenView,
		});

		host.log.info("zen-view loaded; command registered");
	},
};
