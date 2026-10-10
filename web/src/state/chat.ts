import { SendMsg } from "@lib/api";
import { type ChatMessage, type Conversation, db } from "@lib/db";
import { fetchUrlText } from "@lib/fetch";
import { extractMemories, memoryPrompt, mergeMemories } from "@lib/memory";
import { type ProtocolName, protocolNames, providers } from "@lib/providers";
import { searchKindFor, WEB_SEARCH_NAME } from "@lib/providers/presets";
import type {
	AttachmentPart,
	Chunk,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { searchResultCount, searchWeb } from "@lib/tinyfish";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { getActiveProvider, getSettings, setSettings } from "./settings";

export type ChatStatus = "idle" | "streaming";

export interface ChatSnapshot {
	readonly conversations: readonly Conversation[];
	readonly activeId: string;
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
	/** Active conversation's system prompt; `""` when unset. */
	readonly systemPrompt: string;
	/**
	 * True once the initial `db.listConversations()` load has settled (success or
	 * failure). The UI gates the composer on this so a send cannot race hydration
	 * and get dropped when the store replaces its bootstrap conversation.
	 */
	readonly hydrated: boolean;
}

const DEFAULT_TITLE = "New chat";
const TITLE_MAX = 48;

/**
 * Tool-loop bounds: a model must not be able to spin. At most
 * this many tool calls execute in one turn, spread over at most
 * this many request rounds.
 */
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_TOOL_ROUNDS = 4;

/**
 * Last request body successfully sent, per conversation and protocol,
 * replayed as the base for that conversation's next turn. `Conversation`
 * persists only `ChatMessage`s, not the provider wire body, so this is
 * deliberately in-memory: it survives a switch within a session. Keyed
 * by `${conversationId}\u0000${protocol}` so a protocol switch finds no
 * entry and falls back to a transcript seed instead of replaying a body
 * built for a different wire shape. When there is no entry — a fresh
 * session, a reload, or a turn whose request failed (`finalize` deletes
 * it) — `send` seeds it from the conversation's persisted messages.
 */
const prevByConversationProtocol = new Map<string, unknown>();

/** Composite key scoping a conversation's `prev` body to one protocol. */
const prevKey = (conversationId: string, protocol: ProtocolName): string =>
	`${conversationId}\u0000${protocol}`;

let activeFiber: Fiber.Fiber<Exit.Exit<void, string>, never> | undefined;

/**
 * Conversation the in-flight run belongs to. Captured at `send` so a switch
 * mid-stream still writes and persists into the conversation that started it.
 */
let streamConversationId: string | undefined;

/**
 * Identity of the current send run. Bumped when a send starts and when `stop`
 * invalidates the in-flight one, so a stale fiber's finalizer can detect it no
 * longer owns the store and refuse to touch its state.
 */
let runSeq = 0;

let seq = 0;
const nextMessageId = (): string => `msg-${crypto.randomUUID()}`;
const nextConversationId = (): string =>
	`conv-${Date.now().toString(36)}-${++seq}`;

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
};

let conversations: Conversation[] = [];
let activeId = "";
let status: ChatStatus = "idle";
let hydrated = false;
let state: ChatSnapshot = {
	conversations: [],
	activeId: "",
	messages: [],
	status: "idle",
	systemPrompt: "",
	hydrated: false,
};

const activeConversation = (): Conversation | undefined =>
	conversations.find((c) => c.id === activeId);

const findConversation = (id: string): Conversation | undefined =>
	conversations.find((c) => c.id === id);

/** Rebuild the immutable snapshot from mutable fields, then notify subscribers. */
const refresh = (): void => {
	state = {
		conversations,
		activeId,
		messages: activeConversation()?.messages ?? [],
		status,
		systemPrompt: activeConversation()?.systemPrompt ?? "",
		hydrated,
	};
	notify();
};

const updateConversation = (
	id: string,
	change: (conversation: Conversation) => Conversation,
): void => {
	conversations = conversations.map((c) => (c.id === id ? change(c) : c));
};

const sortByRecency = (list: readonly Conversation[]): Conversation[] =>
	[...list].sort((a, b) => b.updatedAt - a.updatedAt);

const makeConversation = (): Conversation => {
	const now = Date.now();
	return {
		id: nextConversationId(),
		title: DEFAULT_TITLE,
		messages: [],
		createdAt: now,
		updatedAt: now,
	};
};

/** First user message becomes the title, truncated; otherwise keep it. */
const deriveTitle = (conversation: Conversation, msg: string): string => {
	if (
		conversation.messages.length > 0 ||
		conversation.title !== DEFAULT_TITLE
	) {
		return conversation.title;
	}
	const text = msg.trim().replace(/\s+/g, " ");
	if (text === "") return DEFAULT_TITLE;
	return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
};

/** Persistence is best-effort: a failure is logged, never thrown at callers. */
const persistConversation = (conversation: Conversation): void => {
	Effect.runFork(
		Effect.catch(db.upsertConversation(conversation), (error) =>
			Effect.logError(`failed to persist conversation: ${error}`),
		),
	);
};

const persistConversationById = (id: string): void => {
	const conversation = findConversation(id);
	if (conversation !== undefined) persistConversation(conversation);
};

/**
 * Marker line shown at a tool-call boundary. Search tools read as a web search;
 * anything else keeps its own name.
 */
const toolMarker = (name: string): string =>
	/search/i.test(name) ? "🔍 searched the web" : `🔧 ${name}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * The answer text of the accumulation: the model's own
 * words, memory blocks stripped. Markers never enter
 * it — `text` is exactly what may go on the wire.
 */
const answerText = (raw: RawText): string => extractMemories(raw.value).text;

/**
 * Record a display-only marker line at the current answer
 * boundary. The offset is the stripped answer's length, so
 * it names a stable position in `text` even once the memory
 * blocks before it are removed (extraction is idempotent and
 * prefix-preserving).
 */
const pushMarker = (raw: RawText, line: string): void => {
	raw.markers.push({ at: answerText(raw).length, line });
};

/**
 * Raw text accumulation shared with `appendChunk`. Memory tags are
 * stripped from the visible text, so the raw accumulation is the
 * single source both the visible text and the next-turn seed derive
 * from: re-extracting over the whole accumulation is idempotent, and
 * a tag split across chunks still never reaches the UI or the store.
 * Markers are kept apart from it — at the stripped answer length
 * each was inserted at — so the transcript interleaves them with the
 * answer text while the accumulation itself stays marker-free (a
 * marker is display-only and must never reach the wire).
 */
interface RawText {
	value: string;
	markers: { readonly at: number; readonly line: string }[];
}

/**
 * Append one streamed chunk to the assistant message, routed by `kind`:
 * `reasoning` (thinking) lands in `reasoning`, `text` (the answer) in `text`,
 * so the two never concatenate into one squished bubble. A `tool` chunk breaks
 * the answer run and drops a marker in its place — the model's text before and
 * after a call must not glue together.
 */
const appendChunk = (
	conversationId: string,
	messageId: string,
	chunk: Chunk,
	raw: RawText,
): void => {
	updateConversation(conversationId, (conversation) => ({
		...conversation,
		messages: conversation.messages.map((m) => {
			if (m.id !== messageId) return m;
			if (chunk.kind === "reasoning") {
				return { ...m, reasoning: (m.reasoning ?? "") + chunk.text };
			}
			if (chunk.kind === "tool") {
				// The marker is display-only: it is recorded in `markers`
				// at the answer offset, so `text` stays the model's own
				// words — exactly what may go on the wire.
				pushMarker(raw, toolMarker(chunk.text));
				return {
					...m,
					text: answerText(raw),
					markers: [...raw.markers],
				};
			}
			// Only `text` accumulates into the answer; every other kind is a
			// no-op, so a new chunk kind (a completed `tool_call` above all)
			// cannot leak into the reply.
			if (chunk.kind !== "text") return m;
			raw.value += chunk.text;
			return { ...m, text: answerText(raw), markers: [...raw.markers] };
		}),
	}));
	refresh();
};

/**
 * Append a display-only marker line to the assistant message — the
 * same seam the `tool` chunk marker uses — for a tool execution's
 * outcome (a fetched page, a failure).
 */
const appendMarker = (
	conversationId: string,
	messageId: string,
	marker: string,
	raw: RawText,
): void => {
	updateConversation(conversationId, (conversation) => ({
		...conversation,
		messages: conversation.messages.map((m) => {
			if (m.id !== messageId) return m;
			pushMarker(raw, marker);
			return { ...m, text: answerText(raw), markers: [...raw.markers] };
		}),
	}));
	refresh();
};

/**
 * Persist memory notes the model ended its reply with. Pure merge through
 * `mergeMemories`, then the settings store; a no-op when the reply carried
 * none or the feature is off.
 */
const commitMemories = (additions: readonly string[]): void => {
	if (additions.length === 0) return;
	const settings = getSettings();
	if (!settings.memoriesEnabled) return;
	setSettings({
		memories: [...mergeMemories(settings.memories, additions, Date.now())],
	});
};

const finalize = (
	myRun: number,
	conversationId: string,
	protocol: ProtocolName,
	exit: Exit.Exit<void, string>,
	next: unknown,
	memories: readonly string[],
): void => {
	// A newer send (or a `stop`) invalidated this run; its finalizer must not
	// touch shared state, or it would clobber the new stream's status/`prev`.
	if (myRun !== runSeq) return;
	activeFiber = undefined;
	streamConversationId = undefined;
	if (Exit.isSuccess(exit)) {
		prevByConversationProtocol.set(prevKey(conversationId, protocol), next);
		commitMemories(memories);
	} else if (!Cause.hasInterruptsOnly(exit.cause)) {
		// The turn failed: drop the stored body so the next turn
		// rebuilds from the transcript — which carries this turn's
		// user message — rather than replay a body that predates
		// it. The failed request's body was never stored, so a
		// rebuild that only fired "when absent" would never run.
		prevByConversationProtocol.delete(prevKey(conversationId, protocol));
		const text = Option.getOrElse(
			Cause.findErrorOption(exit.cause),
			() => "request failed",
		);
		updateConversation(conversationId, (conversation) => ({
			...conversation,
			messages: [
				...conversation.messages,
				{ id: nextMessageId(), role: "error", text, markers: [] },
			],
		}));
	}
	status = "idle";
	updateConversation(conversationId, (conversation) => ({
		...conversation,
		updatedAt: Date.now(),
	}));
	refresh();
	persistConversationById(conversationId);
};

/**
 * One executed tool call: the text returned to the
 * model (the page, the search results, or a failure
 * sentence) and the marker line the transcript shows
 * for it.
 */
interface ToolOutcome {
	readonly result: string;
	readonly marker: string;
	readonly failed: boolean;
	/** The call's arguments, parsed; the loop validated them. */
	readonly input: unknown;
}

/** The transcript marker for a failed fetch. */
const fetchFailedMarker = (sentence: string): string =>
	`🔗 fetch failed: ${sentence}`;

/** The transcript marker for a failed search. */
const searchFailedMarker = (sentence: string): string =>
	`🔍 search failed: ${sentence}`;

/**
 * The call's arguments parsed to a value, or `null` when
 * they are not JSON at all — a parse failure is `null`
 * here, not a failed effect: the call still runs, and
 * fails, as a missing argument.
 */
const parseArguments = (call: ToolCallData): Effect.Effect<unknown> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => JSON.parse(call.args) as unknown,
			catch: () => "arguments were not JSON",
		}),
		() => null,
	);

/**
 * Execute one `fetch_url` call: parse its arguments, fetch the
 * URL's page as text, and render both outcomes as strings — a
 * missing or non-string `url` is a failed result (a sentence, no
 * fetch attempted), never an exception out of the loop. The fetch
 * runs inside the calling fiber, so `stop` interrupts a fetch in
 * flight.
 */
const runFetch = (
	call: ToolCallData,
	tinyfishApiKey: string,
): Effect.Effect<ToolOutcome> =>
	Effect.gen(function* () {
		const parsed = yield* parseArguments(call);
		const url = isRecord(parsed) ? parsed.url : undefined;
		if (typeof url !== "string" || url.trim() === "") {
			const sentence = `${call.name} was called without a URL.`;
			return {
				result: sentence,
				marker: fetchFailedMarker(sentence),
				failed: true,
				input: parsed,
			};
		}
		// The fetch's failure channel is the sentence the transcript
		// shows; either way the outcome is a string for the model.
		const outcome = yield* Effect.catch(
			Effect.map(fetchUrlText(url, tinyfishApiKey), (page) => ({
				ok: true as const,
				page,
			})),
			(sentence) => Effect.succeed({ ok: false as const, sentence }),
		);
		if (!outcome.ok) {
			return {
				result: outcome.sentence,
				marker: fetchFailedMarker(outcome.sentence),
				failed: true,
				input: parsed,
			};
		}
		const host = yield* Effect.orElseSucceed(
			Effect.try({
				try: () => new URL(url).host,
				catch: () => "not a URL",
			}),
			() => url,
		);
		return {
			result: outcome.page,
			marker: `🔗 fetched ${host} (${outcome.page.length.toLocaleString()} chars)`,
			failed: false,
			input: parsed,
		};
	});

/**
 * Execute one `web_search` call: parse its arguments, search
 * through TinyFish, and render both outcomes as strings — a
 * missing or non-string `query` is a failed result (a sentence,
 * no search attempted), never an exception out of the loop. The
 * search runs inside the calling fiber, so `stop` interrupts it.
 */
const runSearch = (
	call: ToolCallData,
	tinyfishApiKey: string,
): Effect.Effect<ToolOutcome> =>
	Effect.gen(function* () {
		const parsed = yield* parseArguments(call);
		const query = isRecord(parsed) ? parsed.query : undefined;
		if (typeof query !== "string" || query.trim() === "") {
			const sentence = `${call.name} was called without a query.`;
			return {
				result: sentence,
				marker: searchFailedMarker(sentence),
				failed: true,
				input: parsed,
			};
		}
		// The search's failure channel is the sentence the
		// transcript shows; either way the outcome is a string
		// for the model.
		const outcome = yield* Effect.catch(
			Effect.map(searchWeb(query.trim(), tinyfishApiKey), (text) => ({
				ok: true as const,
				text,
			})),
			(sentence) => Effect.succeed({ ok: false as const, sentence }),
		);
		if (!outcome.ok) {
			return {
				result: outcome.sentence,
				marker: searchFailedMarker(outcome.sentence),
				failed: true,
				input: parsed,
			};
		}
		// The count is structural — the compact text is
		// one blank-line-separated block per hit — so the
		// marker can say how many results came back.
		const count = searchResultCount(outcome.text);
		return {
			result: outcome.text,
			marker: `🔍 searched the web: ${count.toLocaleString()} result${
				count === 1 ? "" : "s"
			}`,
			failed: false,
			input: parsed,
		};
	});

/**
 * Execute one tool call, dispatched by the tool's name:
 * `web_search` searches the web through TinyFish;
 * `fetch_url` reads a page. The loop declares only these
 * two tools, so a name the model hallucinates falls
 * through to the fetch — it fails there as a missing URL
 * (a sentence), never an exception out of the loop,
 * exactly as an undeclared name behaved before the
 * search tool existed.
 */
const runTool = (
	call: ToolCallData,
	tinyfishApiKey: string,
): Effect.Effect<ToolOutcome> =>
	call.name === WEB_SEARCH_NAME
		? runSearch(call, tinyfishApiKey)
		: runFetch(call, tinyfishApiKey);

export const getChat = (): ChatSnapshot => state;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const useChat = (): ChatSnapshot =>
	useSyncExternalStore(subscribe, getChat);

export const send = (msg: string, parts: AttachmentPart[]): void => {
	if (status === "streaming") return;
	if (msg.trim() === "" && parts.length === 0) return;

	const conversation = activeConversation();
	if (conversation === undefined) return;
	const conversationId = conversation.id;

	const active = getActiveProvider();
	// The composer gates on a configured active provider, but `send` is a public
	// API: refuse rather than stream a request with no protocol to build from.
	if (active === undefined) return;

	const protocol: ProtocolName = active.protocol;
	const provider = providers[protocol];
	const stored = prevByConversationProtocol.get(
		prevKey(conversationId, protocol),
	);
	// No body stored for this conversation+protocol — a fresh
	// session (the map is in-memory), a reload, or a turn whose
	// request failed (`finalize` deletes the entry): rebuild it
	// from the conversation's persisted messages. `conversation`
	// is the snapshot read before this turn's user message was
	// appended, so the seed cannot replay the incoming message
	// twice, and `text` is the marker-free words that may go
	// back on the wire. `error` rows are the app's own words —
	// no wire role matches them — so the seed skips them.
	const prev =
		stored ??
		provider.seedHistory(
			conversation.messages.flatMap((message) => {
				// The app's own rows are not turns the model said anything in,
				// and a failed turn leaves an empty assistant placeholder
				// behind; a row with no words carries nothing to replay.
				if (message.role === "error" || message.text === "") return [];
				return [{ role: message.role, text: message.text }];
			}),
		);

	const searchKind = searchKindFor(active.baseUrl);
	// Only an endpoint with a real mechanism searches; the stored `tools` array is
	// just the on/off + result-count carrier.
	const search =
		searchKind !== null && (active.tools ?? []).length > 0
			? {
					kind: searchKind,
					maxResults: active.tools?.[0]?.max_num_results ?? 5,
				}
			: undefined;

	const settings = getSettings();
	// The memory section is composed for the wire only: the conversation's own
	// `systemPrompt` never changes, and with no notes (or the feature off)
	// `memoryPrompt` is "" so the request is byte-identical to before.
	const memory = settings.memoriesEnabled
		? memoryPrompt(settings.memories)
		: "";

	// The TinyFish key rides the request's ctx (it decides
	// the `web_search` declaration) and every tool
	// execution (it backs the search and the fetch-first
	// route).
	const tinyfishApiKey = settings.tinyfishApiKey;

	const ctx: SendCtx = {
		msg,
		prev,
		apiUrl: active.baseUrl,
		apiKey: active.apiKey,
		model: active.model,
		parts,
		// Tools live on the provider, not globally: the accepted shape is
		// endpoint-specific (OpenAI's built-in is rejected elsewhere).
		tools: active.tools,
		search,
		// The built-in page-fetch tool is a capability the user
		// can turn off; off sends no declaration, so the model
		// cannot call it.
		fetchTool: settings.fetchToolEnabled,
		// A TinyFish key declares the client-side `web_search`
		// tool (where the endpoint has no search of its own)
		// and routes `fetch_url` through TinyFish first.
		tinyfishApiKey,
		systemPrompt: [conversation.systemPrompt ?? "", memory]
			.filter((part) => part !== "")
			.join("\n\n"),
	};

	// Body that would be sent *this* turn. The provider's own `send` builds the
	// identical request from the same ctx; we keep this — plus the streamed reply
	// appended on success — to seed the next turn.
	const buildBody = provider.buildRequest as (
		send: unknown,
		ctx: SendCtx,
	) => unknown;
	const nextBody = buildBody(prev ?? provider.template, ctx);
	const appendAssistant = provider.appendAssistant as (
		send: unknown,
		text: string,
	) => unknown;
	const appendToolResult = provider.appendToolResult as (
		send: unknown,
		call: ToolCallData,
		result: string,
		failed: boolean,
	) => unknown;

	const myRun = ++runSeq;
	streamConversationId = conversationId;
	const assistantId = nextMessageId();
	updateConversation(conversationId, (c) => ({
		...c,
		title: deriveTitle(c, msg),
		messages: [
			...c.messages,
			{ id: nextMessageId(), role: "user", text: msg, parts, markers: [] },
			{ id: assistantId, role: "assistant", text: "", markers: [] },
		],
	}));
	status = "streaming";
	refresh();

	// Raw accumulation of every `text` chunk. `appendChunk` derives the
	// visible text from it (extraction is idempotent), and the finalizer
	// harvests completed memory blocks once the stream settles.
	const raw: RawText = { value: "", markers: [] };
	/**
	 * The body the current round's request replays from: the
	 * turn's `prev` until a tool round extends it, so the
	 * first round's request is byte-identical to a
	 * single-round send (the user message appears once).
	 */
	let replay: unknown = prev;
	/**
	 * The current round's full request body — what the
	 * provider sends and the tool loop extends. Seeded with
	 * this turn's body; a turn with no tool calls never
	 * touches it, so the next-turn seed is byte-identical to
	 * a single-round send.
	 */
	let wire: unknown = nextBody;
	/** Where the final round's text starts in `raw`: its slice is
	 * the reply that seeds the next turn. */
	let finalTextStart = 0;
	/** Tool calls executed so far this turn (the spin bound). */
	let executed = 0;
	const run = Effect.gen(function* () {
		for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
			finalTextStart = raw.value.length;
			// From round 2 the replayed body already carries the
			// turn's user message (round 1 sent it), so the request
			// must not append it again — the question would reach
			// the model once per tool round. Round 1 sends with the
			// flag unset, byte-identical to a single-round send.
			const stream = yield* SendMsg(protocol, {
				...ctx,
				prev: replay,
				skipUserMessage: round > 0,
			});
			const roundCalls: ToolCallData[] = [];
			yield* Stream.runForEach(stream, (chunk) =>
				Effect.sync(() => {
					appendChunk(conversationId, assistantId, chunk, raw);
					if (chunk.kind === "tool_call" && chunk.call !== undefined) {
						roundCalls.push(chunk.call);
					}
				}),
			);
			// A round with no calls is the final answer: the streamed
			// text, already in the message, ends the turn.
			if (roundCalls.length === 0) return;
			// The model's text before the call(s) rides on the
			// assistant message that carries them.
			wire = appendAssistant(wire, raw.value.slice(finalTextStart));
			// Bound the calls: the calls past the cap are dropped, not
			// executed — a tool_call without its result would corrupt
			// the replayed body.
			const room = MAX_TOOL_CALLS_PER_TURN - executed;
			if (room <= 0) return;
			for (const call of roundCalls.slice(0, room)) {
				executed += 1;
				const outcome = yield* runTool(call, tinyfishApiKey);
				appendMarker(conversationId, assistantId, outcome.marker, raw);
				wire = appendToolResult(
					wire,
					{ ...call, input: outcome.input },
					outcome.result,
					outcome.failed,
				);
			}
			// The extended body is the next round's
			// base: the provider rebuilds the request
			// from it (system prompt included). The next
			// round is always a tool round (2+), so its
			// body is built as its request will be —
			// without re-appending the user message the
			// replay already carries (and so the next
			// turn's seed carries the question once).
			replay = wire;
			wire = buildBody(replay, { ...ctx, skipUserMessage: true });
		}
	});

	// On success, seed the next turn with the reply appended so the model sees
	// its own prior answer (`[user, assistant, user]`, not `[user, user]`).
	activeFiber = Effect.runFork(
		Effect.exit(
			run.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						const extracted = extractMemories(raw.value);
						finalize(
							myRun,
							conversationId,
							protocol,
							exit,
							// The final round's text (memory tags
							// stripped), appended to the body the tool
							// loop extended.
							appendAssistant(
								wire,
								extractMemories(raw.value.slice(finalTextStart)).text,
							),
							extracted.memories,
						);
					}),
				),
			),
		),
	);
};

export const stop = (): void => {
	const fiber = activeFiber;
	if (fiber === undefined && status === "idle") return;
	const conversationId = streamConversationId ?? activeId;
	runSeq += 1;
	activeFiber = undefined;
	streamConversationId = undefined;
	if (fiber !== undefined) {
		Effect.runFork(Fiber.interrupt(fiber));
	}
	// Partial text is already in the conversation; keep it, bump and persist.
	status = "idle";
	updateConversation(conversationId, (conversation) => ({
		...conversation,
		updatedAt: Date.now(),
	}));
	refresh();
	persistConversationById(conversationId);
};

export const newConversation = (): void => {
	const conversation = makeConversation();
	conversations = [conversation, ...conversations];
	activeId = conversation.id;
	refresh();
	persistConversation(conversation);
};

export const selectConversation = (id: string): void => {
	if (findConversation(id) === undefined) return;
	activeId = id;
	refresh();
};

export const renameConversation = (id: string, title: string): void => {
	if (findConversation(id) === undefined) return;
	updateConversation(id, (conversation) => ({ ...conversation, title }));
	refresh();
	persistConversationById(id);
};

/** Update the active conversation's system prompt and persist it. */
export const setSystemPrompt = (text: string): void => {
	const conversation = activeConversation();
	if (conversation === undefined) return;
	updateConversation(conversation.id, (current) => ({
		...current,
		systemPrompt: text,
		updatedAt: Date.now(),
	}));
	refresh();
	persistConversationById(conversation.id);
};

export const deleteConversation = (id: string): void => {
	if (findConversation(id) === undefined) return;
	conversations = conversations.filter((c) => c.id !== id);
	// `prev` is keyed per protocol, so a delete must prune every
	// protocol's entry for the conversation, not just one.
	for (const protocol of protocolNames) {
		prevByConversationProtocol.delete(prevKey(id, protocol));
	}
	Effect.runFork(
		Effect.catch(db.deleteConversation(id), (error) =>
			Effect.logError(`failed to delete conversation: ${error}`),
		),
	);
	if (conversations.length === 0) {
		const replacement = makeConversation();
		conversations = [replacement];
		activeId = replacement.id;
		persistConversation(replacement);
	} else if (activeId === id) {
		activeId = conversations[0].id;
	}
	refresh();
};

// Seed a default conversation so the store is usable before hydration resolves;
// it is only persisted when `db` turns out to be empty.
const bootstrap = makeConversation();
conversations = [bootstrap];
activeId = bootstrap.id;
state = {
	conversations,
	activeId,
	messages: [],
	status: "idle",
	systemPrompt: "",
	hydrated: false,
};

const finishHydration = (): void => {
	hydrated = true;
	refresh();
};

Effect.runFork(
	Effect.flatMap(db.listConversations(), (list) =>
		Effect.sync(() => {
			if (list.length === 0) {
				persistConversationById(bootstrap.id);
			} else {
				const ordered = sortByRecency(list);
				conversations = ordered;
				activeId = ordered[0].id;
			}
		}),
	).pipe(
		Effect.catch((error) =>
			Effect.logError(`failed to load conversations: ${error}`),
		),
		// Runs on success and failure alike, so the composer un-gates even if the
		// load failed — never leave the UI permanently disabled.
		Effect.ensuring(Effect.sync(finishHydration)),
	),
);
