import type { ProtocolName } from "@lib/providers";
import type { ToolSpec } from "@lib/providers/types";

export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly protocol: ProtocolName;
	/**
	 * Default tools for this endpoint. Omitted/empty for gateways that reject
	 * OpenAI's built-in — their web search is client-executed, not a declaration.
	 */
	readonly tools?: readonly ToolSpec[];
}

/** OpenAI's server-side web search; only OpenAI-compatible endpoints accept it. */
const OPENAI_TOOLS: readonly ToolSpec[] = [
	{ type: "web_search_preview", max_num_results: 5 },
];

/**
 * Known OpenAI-compatible providers. The base URL carries the API version, so
 * request paths stay bare (`${baseUrl}/chat/completions`, `${baseUrl}/models`).
 * `opencode-go` covers the Go and Go Plus tiers — they share an endpoint and
 * differ only by subscription limits, so one row serves both.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: "openai-responses",
		label: "OpenAI-compatible (Responses)",
		baseUrl: "https://api.openai.com/v1",
		protocol: "responses",
		tools: OPENAI_TOOLS,
	},
	{
		id: "openai-chat",
		label: "OpenAI-compatible (Chat Completions)",
		baseUrl: "https://api.openai.com/v1",
		protocol: "chatcompletions",
		tools: OPENAI_TOOLS,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		protocol: "chatcompletions",
		tools: [],
	},
	{
		id: "opencode-zen",
		label: "OpenCode Zen",
		baseUrl: "https://opencode.ai/zen/v1",
		protocol: "chatcompletions",
		tools: [],
	},
	{
		id: "opencode-go",
		label: "OpenCode Go / Go Plus",
		baseUrl: "https://opencode.ai/zen/go/v1",
		protocol: "chatcompletions",
		tools: [],
	},
	{
		id: "commandcode",
		label: "Command Code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		protocol: "chatcompletions",
		tools: [],
	},
] as const;
