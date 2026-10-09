import { useState } from "react";
import "@/App.css";
import { useChat } from "@/state/chat";
import ChatPane from "@/ui/ChatPane";
import Composer from "@/ui/Composer";
import ConversationList from "@/ui/ConversationList";
import ProfilePicker from "@/ui/ProfilePicker";
import ProviderPicker from "@/ui/ProviderPicker";
import Settings from "@/ui/Settings";
import SystemPrompt from "@/ui/SystemPrompt";

export default function App() {
	const { messages, status } = useChat();
	const [showSettings, setShowSettings] = useState(false);

	return (
		<div className="flex h-full w-full text-left">
			<ConversationList onOpenChat={() => setShowSettings(false)} />
			<main className="flex min-w-0 flex-1 flex-col bg-neutral-950">
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
					<h1 className="min-w-0 truncate text-xs font-medium uppercase tracking-widest text-neutral-300">
						Open Source AI Client
					</h1>
					<div className="flex items-center gap-2">
						<SystemPrompt />
						<ProfilePicker />
						<ProviderPicker />
						<button
							type="button"
							onClick={() => setShowSettings((value) => !value)}
							className="shrink-0 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
						>
							{showSettings ? "Chat" : "Settings"}
						</button>
					</div>
				</header>
				{showSettings ? (
					<Settings />
				) : (
					<>
						<ChatPane messages={messages} status={status} />
						<Composer />
					</>
				)}
			</main>
		</div>
	);
}
