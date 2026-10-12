import type { Host } from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";
import type { ComponentType } from "react";
import {
	ChatPaneView,
	EmptyState,
	MessageList,
	StreamStatus,
} from "@/ui/ChatPane";
import Message, {
	MarkdownBody,
	MarkerBody,
	ReasoningBlock,
} from "@/ui/Message";

/** The registry's component type accepts any props; widen a real-props one. */
const asContribution = <P>(
	component: ComponentType<P>,
): ComponentType<Record<string, unknown>> =>
	component as ComponentType<Record<string, unknown>>;

/**
 * The transcript area's built-in contributions (the chat pane, the message
 * renderers, the empty and streaming states). Registered through the same
 * `host.ui` a plugin uses, so the app's own UI is assembled from the registry
 * exactly as a plugin's would be.
 *
 * The six region ids are the pane, the message list, the per-message region,
 * the per-message actions region, the empty state and the stream status. The
 * four `ui.*` ids are the renderer overrides: `ui.message` is the whole message
 * renderer, and `ui.markdown`/`ui.marker`/`ui.reasoning` are its parts, each
 * resolved by `useComponent` where it renders. All four carry the
 * `chat.message` slot — the region they belong to — but they are consumed
 * through `useComponent`, never a `<Slot>`: a slot renders *every* entry it
 * holds, so rendering `chat.message` alongside four overridable components that
 * share it would render all four as siblings of the message. The message list
 * therefore renders each message through `useComponent("ui.message")`, and
 * `chat.message` stays the region those components declare.
 *
 * The reservation a plugin author must know: because no `<Slot id="chat.message">`
 * is rendered, registering into it through the slot API succeeds and renders
 * **nothing**. `chat.message` is consumed only via `useComponent`, so replacing a
 * renderer means replacing `ui.message` (or `ui.markdown`/`ui.marker`/`ui.reasoning`).
 */
export const registerTranscriptBuiltins = (host: Host): void => {
	const region = (
		id: string,
		slot: SlotId,
		component: ComponentType<Record<string, unknown>>,
	): void => {
		host.ui.register({ id, slot, component, order: 0 });
	};

	region("chat.pane", "chat.pane", asContribution(ChatPaneView));
	region("chat.messages", "chat.messages", asContribution(MessageList));
	region("chat.empty", "chat.empty", asContribution(EmptyState));
	region(
		"chat.stream-status",
		"chat.stream-status",
		asContribution(StreamStatus),
	);

	// Renderer built-ins: resolvable through `useComponent`, see this file's
	// header for why they are not rendered as a slot.
	region("ui.message", "chat.message", asContribution(Message));
	region("ui.markdown", "chat.message", asContribution(MarkdownBody));
	region("ui.marker", "chat.message", asContribution(MarkerBody));
	region("ui.reasoning", "chat.message", asContribution(ReasoningBlock));
};
