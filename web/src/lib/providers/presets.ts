import type { ToolDeclaration } from "@lib/plugins/tools";
import type { ProtocolName } from "@lib/providers";
import type {
	SearchKind,
	SearchSpec,
	SendCtx,
	ToolSpec,
} from "@lib/providers/types";

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
 * True when the endpoint is a server on this machine, which needs no API key.
 * A browser page still needs the server to allow this origin (e.g.
 * `OLLAMA_ORIGINS`); the desktop build has no same-origin limit.
 */
export const isLocalEndpoint = (baseUrl: string): boolean =>
	/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(
		baseUrl.trim(),
	);

/**
 * Anthropic's server-side web search tool declaration: `type`
 * selects the tool version, the required `name` identifies it,
 * and `max_uses` caps the searches performed per request.
 */
const ANTHROPIC_WEB_SEARCH_TYPE = "web_search_20250305";
const ANTHROPIC_WEB_SEARCH_NAME = "web_search";

/**
 * The web-search tool an endpoint needs on the wire, or `undefined`
 * when it has no server-side mechanism. OpenAI executes its built-in
 * `web_search_preview`; OpenRouter takes the `openrouter:web_search`
 * **server tool**, which lets the model decide whether to search at
 * all; Anthropic declares its built-in `web_search` server tool.
 * Never use OpenRouter's deprecated `web` plugin
 * (`plugins:[{id:"web"}]`): it searches **once per request**, so a
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
	if (search?.kind === "anthropic") {
		return [
			{
				type: ANTHROPIC_WEB_SEARCH_TYPE,
				name: ANTHROPIC_WEB_SEARCH_NAME,
				max_uses: search.maxResults,
			},
		];
	}
	return undefined;
};

/**
 * How an endpoint serves web search, read from its base URL. `null`
 * means the endpoint has no server-side search of its own: the per-provider toggle
 * then serves TinyFish's client-side search instead, when a key is set.
 */
export const searchKindFor = (baseUrl: string): SearchKind | null => {
	const url = baseUrl.toLowerCase();
	if (url.includes("openrouter.ai")) return "openrouter";
	if (url.includes("api.openai.com")) return "openai";
	// Anthropic runs its built-in `web_search` server tool itself.
	if (url.includes("api.anthropic.com")) return "anthropic";
	return null;
};

/**
 * The protocols that declare tools on the wire. Local to
 * this module: importing `ProtocolName` from the provider
 * index for these signatures would close a type cycle (the
 * provider modules import `requestTools` from here).
 */
type WireProtocol = "anthropic" | "responses" | "chatcompletions";

/**
 * One tool declaration in the envelope `protocol` wants: chat/completions
 * nests it under `function`, the Responses API takes the flat function shape,
 * and Anthropic declares it with `input_schema`. Every built-in and every
 * **registered** tool goes through here, so a plugin's tool reaches the model
 * in exactly the shape the app's own tools do.
 *
 * This is also the mechanism question for a function tool, and it is answered
 * differently from search's. A function tool is executed by the app's own tool
 * loop, not by the endpoint, so what the endpoint must support is only the
 * *declaration* its protocol carries — and every protocol in {@link
 * WireProtocol} can carry one. There is therefore no `searchKindFor`-style
 * endpoint gate here: every endpoint the app ships (and any plugin protocol
 * built on one of these three) is sent function declarations. A server-side
 * search tool is the opposite — the endpoint runs it — which is why it alone is
 * gated on the endpoint's own mechanism.
 */
const functionTool = (
	protocol: WireProtocol,
	declaration: ToolDeclaration,
): unknown => {
	if (protocol === "anthropic") {
		return {
			name: declaration.name,
			description: declaration.description,
			input_schema: declaration.parameters,
		};
	}
	if (protocol === "responses") {
		return {
			type: "function",
			name: declaration.name,
			description: declaration.description,
			parameters: declaration.parameters,
		};
	}
	return {
		type: "function",
		function: {
			name: declaration.name,
			description: declaration.description,
			parameters: declaration.parameters,
		},
	};
};

/** The built-in URL-fetch tool's name on the wire. */
export const FETCH_URL_NAME = "fetch_url";

/** The client-side web-search tool's name on the wire. */
export const WEB_SEARCH_NAME = "web_search";

/**
 * The wire names whose declaration **host policy** owns, never the registry: the
 * built-in page fetch (the provider's `fetch_url` toggle) and the client-side
 * `web_search` (a TinyFish key + the provider's search toggle, and only where
 * the endpoint has no server-side search of its own). Both built-ins are
 * registered in the tools registry too, so without this a request would declare
 * each of them twice — once from policy and once from the registry — and
 * turning the fetch toggle off would leave the registry copy announcing a tool
 * the user disabled.
 *
 * The rule is by **name** because the wire identity is the name: a plugin
 * cannot take either name anyway (`registerTool` is first-wins and the built-ins
 * register at boot), so the same set reads as "the declarations policy owns".
 */
const policyToolNames: ReadonlySet<string> = new Set([
	FETCH_URL_NAME,
	WEB_SEARCH_NAME,
]);

/**
 * What makes the model use the tool at the right moment: it
 * fetches a URL and returns the page's readable text, so a
 * link in the prompt or a question about a specific page is
 * a call, not a guess.
 */
const FETCH_URL_DESCRIPTION =
	"Fetches a URL and returns the page's readable text. Use it when the user shares a link or asks about a specific page.";

/** The `fetch_url` parameter schema, shared by every envelope. */
const fetchUrlParameters = {
	type: "object",
	properties: {
		url: {
			type: "string",
			description: "The URL to fetch.",
		},
	},
	required: ["url"],
} as const;

/**
 * The built-in `fetch_url` tool in the envelope the
 * protocol wants (see {@link functionTool}).
 */
export const fetchUrlTool = (protocol: WireProtocol): unknown =>
	functionTool(protocol, {
		name: FETCH_URL_NAME,
		description: FETCH_URL_DESCRIPTION,
		parameters: fetchUrlParameters,
	});

/**
 * What makes the model use the search tool: it returns
 * ranked web results — titles, URLs and snippets — for a
 * query, so anything needing current information is a
 * call, not a guess.
 */
const WEB_SEARCH_DESCRIPTION =
	"Searches the web and returns ranked results with titles, URLs and snippets. Use it for recent events or anything you need current information for.";

/** The `web_search` parameter schema, shared by every envelope. */
const webSearchParameters = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "The search query.",
		},
	},
	required: ["query"],
} as const;

/**
 * The client-side `web_search` tool in the envelope the
 * protocol wants (see {@link functionTool}).
 */
export const webSearchTool = (protocol: WireProtocol): unknown =>
	functionTool(protocol, {
		name: WEB_SEARCH_NAME,
		description: WEB_SEARCH_DESCRIPTION,
		parameters: webSearchParameters,
	});

/**
 * True when the request should declare TinyFish's
 * client-side `web_search` tool: a TinyFish key is
 * set, the per-provider search toggle is on (a
 * non-empty `ctx.tools` array), and the endpoint has
 * no search mechanism of its own — `searchKindFor`
 * is the same read `send` uses to build `ctx.search`,
 * so the endpoint's own search always wins and
 * TinyFish fills the gap.
 */
const hasTinyFishSearch = (ctx: SendCtx): boolean => {
	const key = ctx.tinyfishApiKey?.trim() ?? "";
	return (
		key !== "" &&
		(ctx.tools ?? []).length > 0 &&
		searchKindFor(ctx.apiUrl) === null
	);
};

/**
 * The tools one request carries: the endpoint's web-search
 * declaration plus the built-in `fetch_url` tool when the
 * request asks for it (`ctx.fetchTool`), plus TinyFish's
 * client-side `web_search` where it applies, plus every
 * other **registered** tool (`ctx.registeredTools`).
 * `undefined` when nothing applies, so a request with no
 * mechanism sends no `tools` key at all.
 *
 * The first three are host policy and keep their own gates; a registered tool
 * is announced because its plugin registered it. The two are governed
 * differently because the app executes them differently: `fetch_url` and the
 * client-side `web_search` are the app's own capabilities, so the user's
 * toggles decide whether the model may ask for them, while a plugin tool's
 * registry entry **is** its enablement — the loader disposes a plugin's
 * contributions on unload, so an entry's presence already means the plugin is
 * enabled and its tool is callable. Declaring it needs no second permission.
 *
 * The policy-owned names are dropped from `registeredTools` (see
 * {@link policyToolNames}), which is what keeps a built-in declared once and
 * keeps a disabled fetch tool off the wire.
 */
export const requestTools = (
	ctx: SendCtx,
	protocol: WireProtocol,
): readonly unknown[] | undefined => {
	const search = searchTools(ctx.search, ctx.tools);
	const fetchTool =
		ctx.fetchTool === true ? [fetchUrlTool(protocol)] : undefined;
	const tinyfishSearch = hasTinyFishSearch(ctx)
		? [webSearchTool(protocol)]
		: undefined;
	const registered = (ctx.registeredTools ?? [])
		.filter((declaration) => !policyToolNames.has(declaration.name))
		.map((declaration) => functionTool(protocol, declaration));
	const tools = [
		...(search ?? []),
		...(fetchTool ?? []),
		...(tinyfishSearch ?? []),
		...registered,
	];
	return tools.length === 0 ? undefined : tools;
};

/**
 * Known providers. The base URL carries the API version, so
 * request paths stay bare (`${baseUrl}/chat/completions`,
 * `${baseUrl}/models`, `${baseUrl}/messages`). `opencode-go`
 * covers the Go and Go Plus tiers — they share an endpoint and
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
		id: "anthropic",
		label: "Anthropic-compatible (Messages)",
		baseUrl: "https://api.anthropic.com/v1",
		protocol: "anthropic",
		tools: [],
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
	{
		id: "ollama",
		label: "Ollama (local)",
		baseUrl: "http://localhost:11434/v1",
		protocol: "chatcompletions",
		tools: [],
	},
	{
		id: "lmstudio",
		label: "LM Studio (local)",
		baseUrl: "http://localhost:1234/v1",
		protocol: "chatcompletions",
		tools: [],
	},
] as const;
