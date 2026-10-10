import type { ProtocolName } from "@lib/providers";
import type { SearchKind, SearchSpec, ToolSpec } from "@lib/providers/types";

export interface ProviderPreset {
	readonly id: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly protocol: ProtocolName;
	/**
	 * Default tools for this endpoint. The wire shape is chosen by the
	 * endpoint itself (see `searchKindFor`), not by this array.
	 */
	readonly tools?: readonly ToolSpec[];
}

/** OpenAI's server-side web search; only OpenAI-compatible endpoints accept it. */
const OPENAI_TOOLS: readonly ToolSpec[] = [
	{ type: "web_search_preview", max_num_results: 5 },
];

/**
 * The web-search tool an endpoint needs on the wire, or `undefined` when it has
 * no server-side mechanism. OpenAI executes its built-in `web_search_preview`;
 * OpenRouter takes the `openrouter:web_search` **server tool**, which lets the
 * model decide whether to search at all. Never use OpenRouter's deprecated
 * `web` plugin (`plugins:[{id:"web"}]`): it searches **once per request**, so a
 * bare "nice" becomes a query for the city.
 */
export const searchTools = (
	search: SearchSpec | undefined,
	tools: readonly ToolSpec[] | undefined,
): readonly unknown[] | undefined => {
	if (search?.kind === "openai") return tools;
	if (search?.kind === "openrouter") {
		return [
			{
				type: "openrouter:web_search",
				parameters: { max_results: search.maxResults },
			},
		];
	}
	return undefined;
};

/**
 * How an endpoint serves web search, read from its base URL. `null` means
 * the endpoint has no server-side search — the toggle must stay inert there.
 */
export const searchKindFor = (baseUrl: string): SearchKind | null => {
	const url = baseUrl.toLowerCase();
	if (url.includes("openrouter.ai")) return "openrouter";
	if (url.includes("api.openai.com")) return "openai";
	return null;
};

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
