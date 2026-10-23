import type { ToolDeclaration } from "@lib/plugins/tools";
import type { ProtocolName } from "@lib/providers";
import type {
	SearchKind,
	SearchSpec,
	SendCtx,
	ToolSpec,
} from "@lib/providers/types";
import { SITE_URL } from "@/constants/links";

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
 * True for an endpoint whose model list a webview cannot reach at all. Measured
 * 2026-10-23 on Volcengine ARK: `OPTIONS /api/v3/chat/completions` answers 200
 * with the caller's origin and `authorization` allowed, while `OPTIONS
 * /api/v3/models` is a 404 with no CORS header — so the `Authorization` header
 * forces a preflight the host refuses, and the fetch rejects with a bare
 * `TypeError: Load failed` while chat keeps working. Scoped to the host, not the
 * provider preset, so a custom base URL on the same service is covered.
 */
export const refusesModelsPreflight = (baseUrl: string): boolean =>
	baseUrl.toLowerCase().includes(".volces.com/");

/**
 * What to show when that refusal is the cause: the id the user must type
 * instead, since no list will ever arrive here.
 */
export const MODELS_LIST_REFUSAL =
	"This endpoint does not answer the preflight on its model list (Volcengine ARK returns 404 for OPTIONS /api/v3/models), so the list cannot be fetched here even though chat works. Type the model instead — for ARK that is the endpoint id (ep-…) or the model name from the console.";

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
 * True for an OpenCode host — the endpoint family that needs
 * `x-opencode-session` and whose chat endpoint refuses a browser's CORS
 * preflight. One read, so the two rules below cannot disagree about which
 * endpoint they are talking about.
 */
export const isOpencodeHost = (baseUrl: string): boolean =>
	baseUrl.toLowerCase().includes("opencode.ai");

/**
 * The session header OpenCode's inference endpoints require **before** they
 * look at credentials — without it the reply is `MissingSessionID`, with it the
 * endpoint routes the conversation and its prompt cache. The docs ask for "a
 * stable session ID in `x-opencode-session` for each conversation"
 * (https://opencode.ai/v2/docs/console/go/), so the value is the app's own id
 * for that conversation: stable for the whole conversation, across turns, app
 * runs and reloads, and never regenerated per request. Empty for every other
 * host — an unknown header on someone else's endpoint is at best noise.
 */
export const sessionHeadersFor = (
	baseUrl: string,
	conversationId: string,
): Record<string, string> =>
	isOpencodeHost(baseUrl) ? { "x-opencode-session": conversationId } : {};

/**
 * True for an OpenRouter host. One read, so the attribution rule and the search
 * rule cannot disagree about which endpoint they are talking about.
 */
export const isOpenRouterHost = (baseUrl: string): boolean =>
	baseUrl.toLowerCase().includes("openrouter.ai");

/** The app's display name in OpenRouter's rankings. */
export const OPENROUTER_APP_TITLE = "Open Source AI Client";

/** Up to two recognized marketplace categories (`general-chat`, `programming-app`). */
export const OPENROUTER_APP_CATEGORIES = "general-chat,programming-app";

/**
 * OpenRouter's app-attribution headers, and only for an OpenRouter endpoint.
 *
 * `HTTP-Referer` is the identifier that creates the app page and puts its usage
 * in the public rankings; a title alone creates nothing. The other two are the
 * display name and up to two categories, unrecognized ones being dropped
 * without an error (https://openrouter.ai/docs/app-attribution).
 *
 * The public site is the referer rather than the page's own origin: a desktop
 * webview's origin is `tauri://localhost`, which names no app.
 *
 * `enabled` is the provider's own `attribution` flag (on by default): off sends
 * none of the three, so a user who does not want their usage on OpenRouter's
 * public app page keeps every other header and the request itself.
 */
export const attributionHeadersFor = (
	baseUrl: string,
	enabled = true,
): Record<string, string> =>
	isOpenRouterHost(baseUrl) && enabled
		? {
				"HTTP-Referer": SITE_URL,
				"X-OpenRouter-Title": OPENROUTER_APP_TITLE,
				"X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
			}
		: {};

/**
 * True for a host whose chat endpoint refuses a browser's CORS preflight: its
 * `OPTIONS` answers 404 with no `access-control-allow-origin` (while `/models`
 * on the same host answers `acao=*`), so a web page never sends the POST at
 * all. The desktop transport is the supported route for it.
 */
export const refusesBrowserPreflight = (baseUrl: string): boolean =>
	isOpencodeHost(baseUrl);

/**
 * What a web-mode request to such a host fails with. A browser reports a
 * refused cross-origin request as `TypeError: Load failed` and nothing else,
 * which a user cannot act on.
 */
export const PREFLIGHT_REFUSAL =
	"This endpoint refuses the browser's cross-origin preflight, so a web page cannot send this request at all. The desktop app sends it directly.";

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
 *
 * `openai-responses`/`openai-chat` share a base URL because OpenAI
 * serves both families from one, and `opencode-go` is the same shape:
 * its docs give **one** prefix for every Go model
 * (https://opencode.ai/docs/go/, "Endpoints" — the family is the method
 * path, `/chat/completions` vs `/responses` vs `/messages`), so its row
 * is the Chat Completions family and the Protocol dropdown reaches the
 * other two over the same base. The page's own model list is
 * `${baseUrl}/models`, which is the path this app builds.
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
		baseUrl: "https://opencode.ai/inference/go/v1",
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
		/**
		 * Volcengine's ARK (方舟) platform: OpenAI-compatible Chat Completions,
		 * one base URL carrying the version, Bearer auth. Its `model` field is
		 * an endpoint id (`ep-…`) or a model name (`deepseek-v3-250324`,
		 * `doubao-seed-…`), exactly as the console lists it.
		 *
		 * No default tools: ARK's chat API has no server-side web search (the
		 * 豆包搜索 capability is a separate product), so `searchKindFor` stays
		 * `null` and TinyFish fills the gap when a key is set.
		 */
		id: "ark",
		label: "Volcengine ARK",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
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
	{
		id: "orcarouter",
		label: "OrcaRouter",
		baseUrl: "https://api.orcarouter.ai/v1",
		protocol: "chatcompletions",
		tools: [],
	},
] as const;

/**
 * Merge plugin-registered presets onto the built-in list: built-ins first, then
 * live entries, deduped by id (a built-in always wins a collision). Pure: the
 * input order of `live` is preserved for the entries that survive.
 */
export const mergeProviderPresets = (
	builtins: readonly ProviderPreset[],
	live: readonly ProviderPreset[],
): readonly ProviderPreset[] => {
	const seen = new Set(builtins.map((preset) => preset.id));
	const out: ProviderPreset[] = [...builtins];
	for (const preset of live) {
		if (seen.has(preset.id)) continue;
		seen.add(preset.id);
		out.push(preset);
	}
	return out;
};
