// The plugin examples this app ships (source: web/plugins/*/plugin.json). Kept
// as a committed list so the command palette can search them without a network
// request. The runtime index is only fetched when the Settings page opens.
// shippedExamples.test.ts asserts this list matches the on-disk manifests
// exactly, so adding an example forces an update here.

export interface ShippedPluginExample {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export const SHIPPED_PLUGIN_EXAMPLES: readonly ShippedPluginExample[] = [
	{
		id: "custom-tool",
		name: "Shout tool",
		description:
			"Registers a model-callable `shout` tool, plus an onToolCall stage that refuses calls carrying a forbidden argument.",
	},
	{
		id: "export-conversation",
		name: "Export conversation",
		description:
			'Adds an "Export conversation as Markdown" command that reads the active conversation and downloads it.',
	},
	{
		id: "hello-world",
		name: "Hello world",
		description:
			"Adds one button to every message's action row; proves a ui slot, the Host object and the plugin lifecycle.",
	},
	{
		id: "history-pipeline",
		name: "History pipeline",
		description:
			"Three pipeline stages (onHistory trims to the last 4 turns, beforeSend aborts on an empty prompt, afterReply logs one stat line). Shows the fail-open contract.",
	},
	{
		id: "markdown-callouts",
		name: "Markdown callouts",
		description:
			"Overrides the markdown renderer to render > [!note]-style callouts as styled boxes, delegating every other document to the built-in kit renderer.",
	},
	{
		id: "sidebar-notes",
		name: "Sidebar notes",
		description:
			"A chrome slot (app.sidebar) with real per-conversation persistence: add and delete notes, storage keys/delete, confirm before delete, re-read on conversation-changed.",
	},
	{
		id: "theme-solarized",
		name: "Solarized theme",
		description:
			"Registers a Solarized colour theme and a Settings section that applies it; the choice survives a reload.",
	},
	{
		id: "zen-view",
		name: "Zen view",
		description:
			"Owns the whole window: a fixed full-viewport root layout opened by a command and closed by Escape, reading host.chat through host.run.",
	},
];
