import type { ProtocolName } from "@lib/providers";

export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly protocol: ProtocolName;
}

/**
 * Known OpenAI-compatible providers. The base URL carries the API version, so
 * request paths stay bare (`${baseUrl}/chat/completions`, `${baseUrl}/models`).
 * `opencode-go` and `opencode-go-plus` share an endpoint; they differ only by
 * subscription limits, so both stay listed for discoverability.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: "openai-responses",
		label: "OpenAI (Responses)",
		baseUrl: "https://api.openai.com/v1",
		protocol: "responses",
	},
	{
		id: "openai-chat",
		label: "OpenAI (Chat Completions)",
		baseUrl: "https://api.openai.com/v1",
		protocol: "chatcompletions",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		protocol: "chatcompletions",
	},
	{
		id: "opencode-zen",
		label: "OpenCode Zen",
		baseUrl: "https://opencode.ai/zen/v1",
		protocol: "chatcompletions",
	},
	{
		id: "opencode-go",
		label: "OpenCode Go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		protocol: "chatcompletions",
	},
	{
		id: "opencode-go-plus",
		label: "OpenCode Go Plus",
		baseUrl: "https://opencode.ai/zen/go/v1",
		protocol: "chatcompletions",
	},
	{
		id: "commandcode",
		label: "Command Code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		protocol: "chatcompletions",
	},
] as const;
