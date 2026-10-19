import { SendMsg } from "@lib/api";
import { type ChatMessage, type Conversation, db } from "@lib/db";
import {
	type ExtractedMemories,
	extractMemories,
	memoryLogLines,
	memoryPrompt,
	recordMemories,
} from "@lib/memory";
import type { BuiltinId } from "@lib/plugins/builtinIdentity";
import { HostServices } from "@lib/plugins/host";
import {
	composeTurnBody,
	type PipelineMeta,
	resolveToolCall,
	run as runPipeline,
	stageRunner,
} from "@lib/plugins/pipeline";
import { protocolNames, resolveProviderSync } from "@lib/plugins/providers";
import { runtime } from "@lib/plugins/runtime";
import {
	publishChatSnapshot,
	publishHostEvent,
	registerChatStore,
} from "@lib/plugins/services";
import {
	executeTool,
	type ToolDeclaration,
	type ToolEntry,
} from "@lib/plugins/tools";
import { searchKindFor } from "@lib/providers/presets";
import type {
	AttachmentPart,
	Chunk,
	SendCtx,
	ToolCallData,
} from "@lib/providers/types";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { getBuiltinsSnapshot } from "@/state/builtins";
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

/** The error row a `beforeSend` stage's `Option.none()` leaves behind (spec §5). */
const ABORTED_TURN = "The turn was aborted by a plugin.";

/**
 * A tool call a plugin vetoed still records a result: the wire must never
 * carry a `tool_call` without its matching result (spec §5, and the reason a
 * veto is not simply a skipped execution).
 */
const DECLINED_RESULT = "A plugin declined this tool call.";
const declinedMarker = (name: string): string =>
	`🔧 ${name} declined by a plugin`;

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
const prevKey = (conversationId: string, protocol: string): string =>
	`${conversationId}\u0000${protocol}`;

/**
 * Every tool the host's registry holds, as the declarations a request
 * announces — read once per turn, on the turn's own runtime.
 *
 * `tools.ts` is the tool registry's only writer, and `addTool` validates each
 * declaration with `toolDeclarationSchema` before storing it — an invalid one
 * is refused there, with a logged `PluginFault`, and never stored. So every
 * entry read here already carries a parsed `ToolDeclaration`; this reads the
 * generic `RegistryEntry` at that shape rather than re-parsing. A second parse
 * on the way out could only make a stored, valid declaration vanish silently,
 * and the write side is where an invalid one is refused and reported.
 *
 * The **registry is the enablement**: the loader disposes a plugin's
 * contributions when it unloads, so an entry's presence already means that
 * plugin is enabled and its tool can be called. That is why a registered tool
 * needs no toggle of its own, where `fetch_url` and the client-side
 * `web_search` — the app's own capabilities — are governed by user settings.
 * Filtering the policy-owned names out is `requestTools`'s job when it
 * assembles the body, so this read stays a plain registry read.
 */
export const registeredToolDeclarations: Effect.Effect<
	readonly ToolDeclaration[],
	never,
	HostServices
> = Effect.gen(function* () {
	const services = yield* HostServices;
	const entries = yield* services.tools.entries();
	// The narrowing is sound for the same reason: only `addTool` writes, and it
	// stores a validated `ToolEntry`, so no non-tool entry can be read back.
	return entries.map((entry) => (entry as ToolEntry).declaration);
});

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
	// The host services read the store through these two synchronous sinks:
	// `host.chat.changes` gets the snapshot, and `host.on("conversation-changed")`
	// gets the same change. `refresh` is the store's one mutation path, so the
	// bus and the stream cannot disagree with what the UI sees (spec §3/§5).
	publishChatSnapshot(state);
	publishHostEvent("conversation-changed", state);
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

/**
 * The text a reply renders with: memory blocks stripped while the feature is
 * live, the raw accumulation while it is off. An area that is off interprets
 * nothing of its own, so the tag is ordinary prose then — rendered whole, and
 * never a truncation. (Live, a complete block is removed and an unterminated
 * one drops the rest of the reply; see `extractMemories`.)
 */
const displayText = (text: string): string =>
	memoryActive() ? extractMemories(text).text : text;

/**
 * The answer text of the accumulation: the model's own
 * words, memory blocks stripped while the feature is live. Markers
 * never enter it — `text` is exactly what may go on the wire.
 */
const answerText = (raw: RawText): string => displayText(raw.value);

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
 * Raw text accumulation shared with `appendChunk`. Memory blocks are
 * stripped from the visible text while the memory feature is live (and left
 * verbatim while it is off), so the raw accumulation is the single source both
 * the visible text and the next-turn seed derive from: re-extracting over the
 * whole accumulation is idempotent, and a complete block never reaches the UI
 * or the store. A *partial* tag is ordinary prose and does render, so a marker
 * split across chunks can appear for the frame that carries it — the spec's
 * chosen trade, because chopping it would truncate real text. Markers are kept
 * apart from it — at the stripped answer length each was inserted at — so the
 * transcript interleaves them with the answer text while the accumulation
 * itself stays marker-free (a marker is display-only and must never reach the
 * wire).
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
	// Every streamed chunk is a host event (spec §3), published after the
	// snapshot so a `chunk` subscriber sees the message the chunk landed in.
	publishHostEvent("chunk", chunk);
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
 * The `app.memory` area's id, pinned to the identity table's union so renaming
 * the area there is a type error here rather than a silently ungated read.
 */
const MEMORY_AREA_ID = "app.memory" satisfies BuiltinId;

/**
 * Whether the memory feature is live: the `app.memory` area **and** the
 * `memoriesEnabled` setting. One predicate for the whole feature — the
 * injected prompt, the note store and the reply-text strip all read it — so
 * "off" means *nothing* about memory happens, not merely that its UI is
 * hidden. With the area off the section and the five tools are gone, and a
 * note recorded or injected anyway would be invisible, with no UI to see or
 * remove it; with the setting off the feature retires one level in.
 *
 * Cheap and synchronous on purpose: the streaming render path calls it once
 * per frame. The area is read from the builtins store's synchronous snapshot
 * (`getBuiltinsSnapshot`), the same shape the Plugins manager reads: absent
 * means on, and the store itself clamps a locked area on. `=== true` because
 * `resolve` writes an explicit flag for every identity in the table, this one
 * included.
 */
const memoryActive = (): boolean =>
	getBuiltinsSnapshot().builtins[MEMORY_AREA_ID] === true &&
	getSettings().memoriesEnabled;

/**
 * Persist memory notes the model ended its reply with. The tag path is the
 * documented fallback for endpoints that cannot be sent tool declarations, so
 * it routes through T1's single mutator (`recordMemories`) exactly as the five
 * memory tools do: a complete block adds one entry to the note store under a
 * generated id **and** mirrors the same dedupe decision into the legacy
 * `memories` array.
 *
 * The whole feature's one predicate guards the write, before the malformed
 * diagnostic: with the area off (or the setting off) nothing about memory
 * happens, so neither the store nor the console mentions a tag that is, then,
 * ordinary prose. The malformed diagnostic is still emitted for a live
 * feature even when the reply carried no block — the caller harvests
 * `extractMemories` and this logs what it flagged.
 */
const commitMemories = (extracted: ExtractedMemories): void => {
	// Deliberately redundant with the `memoryActive()` harvest in `finalize`
	// (the `extracted` argument's build site): both gates exist so "off" is
	// decided by one predicate at every memory surface; removing either alone
	// changes nothing observably, only removing both fails a test.
	if (!memoryActive()) return;
	for (const line of memoryLogLines(extracted)) {
		Effect.runFork(Effect.logWarning(line));
	}
	if (extracted.memories.length === 0) return;
	const settings = getSettings();
	const recorded = recordMemories(
		settings.memories,
		settings.memoryNotes,
		extracted.memories,
		Date.now(),
	);
	setSettings({
		memories: [...recorded.memories],
		memoryNotes: [...recorded.notes],
	});
};

const finalize = (
	myRun: number,
	conversationId: string,
	protocol: string,
	exit: Exit.Exit<void, string>,
	next: unknown,
	extracted: ExtractedMemories,
): void => {
	// A newer send (or a `stop`) invalidated this run; its finalizer must not
	// touch shared state, or it would clobber the new stream's status/`prev`.
	if (myRun !== runSeq) return;
	activeFiber = undefined;
	streamConversationId = undefined;
	if (Exit.isSuccess(exit)) {
		prevByConversationProtocol.set(prevKey(conversationId, protocol), next);
		commitMemories(extracted);
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
	publishHostEvent("turn-end", {
		conversationId,
		protocol,
		ok: Exit.isSuccess(exit),
	});
};

export const getChat = (): ChatSnapshot => state;

export const subscribe = (cb: () => void): (() => void) => {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
};

export const useChat = (): ChatSnapshot =>
	useSyncExternalStore(subscribe, getChat);

/** One turn's user message, as a subscriber sees it. */
export interface UserMessageSignal {
	readonly conversationId: string;
	readonly text: string;
}

/** Everyone watching {@link subscribeUserMessage}. */
const userMessageHandlers = new Set<(signal: UserMessageSignal) => void>();

/**
 * Publish one already-appended user message. Each handler runs in its own
 * isolated step, exactly as `publishHostEvent` does: the subscriber is another
 * module's code (the `app.titler` area), and a turn must never fail because an
 * observer did — the signal is an observation, not a step in the send.
 */
const publishUserMessage = (signal: UserMessageSignal): void => {
	for (const handler of [...userMessageHandlers]) {
		Effect.runSync(
			Effect.sync(() => handler(signal)).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						`a user-message subscriber faulted and was skipped: ${Cause.pretty(cause)}`,
					),
				),
			),
		);
	}
};

/**
 * The user message of one `send`, published **once the row is in the store** —
 * the signal a titler titles a conversation from.
 *
 * **Why not `turn-start`:** it is published *before* this turn's user row is
 * appended, and its payload is `{conversationId, protocol}` only — no messages,
 * no text — so a synchronous subscriber sees a conversation with nothing to
 * title. The same point's other existing signal, `conversation-changed` (and
 * `host.chat.changes`), does carry the snapshot, but it fires on *every* store
 * write — each streamed chunk, `finalize` — so it cannot say "this is a new
 * turn's message"; and a new host event *name* is an edit to the bus's closed
 * vocabulary (`lib/plugins/ids.ts`), not to the store. This signal is the
 * store's own, fired synchronously from the send path.
 *
 * **Per send, not per conversation.** It fires for the user row of every turn
 * that appends one as the turn's newest row — never for the `unknown protocol`
 * path, whose write also adds an `error` row. Deciding that this was a
 * conversation's *first* message (`messages.length === 1`) is the subscriber's
 * job, beside the title-source check, because both halves belong to the
 * trigger that consumes this.
 */
export const subscribeUserMessage = (
	handler: (signal: UserMessageSignal) => void,
): (() => void) => {
	userMessageHandlers.add(handler);
	return () => {
		userMessageHandlers.delete(handler);
	};
};

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

	// The turn is under way (spec §3's `turn-start`). Published here, after the
	// guards, so every `turn-start` has a matching `turn-end` below.
	publishHostEvent("turn-start", {
		conversationId,
		protocol: active.protocol,
	});

	// `protocol` is a plain string on the wire-facing schema — a plugin may
	// register one — so the registry decides whether it resolves. `send` builds
	// its request body synchronously and shows the turn immediately, so this is
	// the sync read; a name that does not resolve is a failed turn here, never
	// a crash on an absent provider.
	const protocol = active.protocol;
	const resolved = resolveProviderSync(protocol);
	if (Option.isNone(resolved)) {
		updateConversation(conversationId, (conversation) => ({
			...conversation,
			title: deriveTitle(conversation, msg),
			messages: [
				...conversation.messages,
				{ id: nextMessageId(), role: "user", text: msg, parts, markers: [] },
				{
					id: nextMessageId(),
					role: "error",
					text: `unknown protocol: ${protocol}`,
					markers: [],
				},
			],
			// The failed turn still moved the conversation (Task 11 review):
			// without this the row lands but `updatedAt` stays stale, unlike
			// `finalize`'s failure path.
			updatedAt: Date.now(),
		}));
		refresh();
		persistConversationById(conversationId);
		publishHostEvent("turn-end", { conversationId, protocol, ok: false });
		return;
	}
	const provider = resolved.value;
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
	const meta: PipelineMeta = { conversationId, protocol };

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
	// `systemPrompt` never changes, and with no live notes (or memory off)
	// `memoryPrompt` is "" so the request is byte-identical to before. "Off"
	// is the feature's one predicate: the area **and** the setting, because
	// the area owns the feature, so its toggle has to take the injected prompt
	// with the section, the tools and the reply-text strip, or an area
	// switched off would keep steering every request.
	const memory = memoryActive() ? memoryPrompt(settings.memoryNotes) : "";

	// The TinyFish key rides the request's ctx (it decides
	// the `web_search` declaration) and every tool
	// execution (it backs the search and the fetch-first
	// route).
	const tinyfishApiKey = settings.tinyfishApiKey;

	const baseCtx: SendCtx = {
		msg,
		// The replay base is resolved inside the run: a seed goes through
		// `onHistory` first, and the loop passes the turn's actual body as
		// `prev`. `stored` is what the provider's `buildRequest` starts from.
		prev: stored,
		apiUrl: active.baseUrl,
		apiKey: active.apiKey,
		model: active.model,
		// The conversation this turn belongs to, so an endpoint that needs a
		// per-conversation session header is sent this conversation's own id.
		conversationId,
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

	// The provider's own request builder and body appenders. The registry
	// erases the wire body's type (one registry holds every protocol's), so
	// these are read at the erased shape the caller drives them with.
	const buildBody: (send: unknown, ctx: SendCtx) => unknown =
		provider.buildRequest;
	const appendAssistant: (send: unknown, text: string) => unknown =
		provider.appendAssistant;
	const appendToolResult: (
		send: unknown,
		call: ToolCallData,
		result: string,
		failed: boolean,
	) => unknown = provider.appendToolResult;

	const myRun = ++runSeq;
	streamConversationId = conversationId;
	const assistantId = nextMessageId();
	// The user's row lands now; the assistant placeholder is added inside the
	// run once `beforeSend` has not aborted, so an abort leaves no empty
	// assistant bubble behind (its error row is `finalize`'s).
	updateConversation(conversationId, (c) => ({
		...c,
		title: deriveTitle(c, msg),
		messages: [
			...c.messages,
			{ id: nextMessageId(), role: "user", text: msg, parts, markers: [] },
		],
	}));
	status = "streaming";
	refresh();
	// The user's row is in the store, so a subscriber can now read it with its
	// text (`subscribeUserMessage`). Published after `refresh`, so the snapshot
	// a handler reads and this signal cannot disagree.
	publishUserMessage({ conversationId, text: msg });

	// Raw accumulation of every `text` chunk. `appendChunk` derives the
	// visible text from it (extraction is idempotent), and the finalizer
	// harvests completed memory blocks once the stream settles.
	const raw: RawText = { value: "", markers: [] };
	/**
	 * The turn's one body: built from the seed (or stored replay) and passed
	 * through `transformBody` once, then replayed as `prev` for every round
	 * with `skipUserMessage` (it already carries the user message). The tool
	 * loop extends this same body, so what the provider sends and what
	 * `finalize` stores are one body — they cannot drift.
	 *
	 * Seeded with the provider's template, never left undefined: a `beforeSend`
	 * veto fails the turn *before* the body is composed, and the finalizer still
	 * hands it to `appendAssistant`. `finalize` ignores the body on a failed
	 * turn, but the appender reads it — an unset `wire` would throw there, so
	 * `finalize` would never run and `status`/`activeFiber` would be stranded.
	 */
	let wire: unknown = provider.template;
	/** Where the final round's text starts in `raw`: its slice is
	 * the reply that seeds the next turn. */
	let finalTextStart = 0;
	/** Tool calls executed so far this turn (the spin bound). */
	let executed = 0;
	const run = Effect.gen(function* () {
		// Seed the turn's base: the stored body for this conversation+protocol,
		// or a transcript rebuilt from its turns through `onHistory` (spec §5).
		// `conversation` is the snapshot before this turn's user message, so
		// the seed cannot replay the incoming message twice, and `error` rows
		// are the app's own words — no wire role matches them — so they are
		// skipped.
		const prev =
			stored ??
			provider.seedHistory(
				yield* runPipeline(
					"onHistory",
					conversation.messages.flatMap((message) => {
						const parts = message.parts ?? [];
						// A row with neither words nor attachments carries
						// nothing to replay. A turn that carried only a file
						// must survive the rebuild, so attachments count.
						if (
							message.role === "error" ||
							(message.text === "" && parts.length === 0)
						)
							return [];
						return [
							{
								role: message.role,
								text: message.text,
								...(parts.length > 0 ? { parts } : {}),
							},
						];
					}),
					meta,
				),
			);

		// `beforeSend` augments or rewrites the turn's context, or aborts the
		// turn (spec §5). Inside the run, so a stage may await a host service;
		// `none` fails the turn, whose error row `finalize` writes. The
		// registered tools ride the ctx from here on, so `beforeSend` sees them
		// and every round's rebuild of the body re-declares exactly them.
		const registeredTools = yield* registeredToolDeclarations;
		const outgoing = yield* runPipeline(
			"beforeSend",
			{ ...baseCtx, prev, registeredTools },
			meta,
		);
		if (Option.isNone(outgoing)) return yield* Effect.fail(ABORTED_TURN);
		const ctx = outgoing.value;

		// The one body this turn sends and stores; `transformBody` runs here,
		// once, over the built body (spec §5).
		wire = yield* composeTurnBody(
			buildBody,
			prev ?? provider.template,
			ctx,
			meta,
		);

		updateConversation(conversationId, (c) => ({
			...c,
			messages: [
				...c.messages,
				{ id: assistantId, role: "assistant", text: "", markers: [] },
			],
		}));
		refresh();

		for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
			finalTextStart = raw.value.length;
			// Resolve the chunk stage once for the whole round, not once per
			// streamed chunk. The row replayed to the provider is the turn's
			// one body; `skipUserMessage` stops `buildRequest` from appending
			// the user message it already carries.
			const onChunk = yield* stageRunner("onChunk", meta);
			const stream = yield* SendMsg(protocol, {
				...ctx,
				prev: wire,
				skipUserMessage: true,
			});
			const roundCalls: ToolCallData[] = [];
			// `onChunk` rewrites or drops one streamed chunk (spec §5) before it
			// reaches the accumulator; a dropped chunk is simply absent, and the
			// stream still terminates. Piped here so providers stay untouched.
			const processed = stream.pipe(
				Stream.mapEffect((chunk) => onChunk.run(chunk)),
				Stream.filter(Option.isSome),
				Stream.map((option) => option.value),
			);
			yield* Stream.runForEach(processed, (chunk) =>
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
			const onToolCall = yield* stageRunner("onToolCall", meta);
			for (const call of roundCalls.slice(0, room)) {
				executed += 1;
				// `onToolCall` may veto or rewrite the call (spec §5). A vetoed
				// call still records a result through `appendToolResult`, so the
				// replayed body never carries a `tool_call` without its matching
				// result — the dangling-call 400 on the next turn.
				const decision = yield* onToolCall.run(call);
				const { call: effective, execute: shouldExecute } = resolveToolCall(
					call,
					decision,
				);
				if (!shouldExecute) {
					appendMarker(
						conversationId,
						assistantId,
						declinedMarker(call.name),
						raw,
					);
					wire = appendToolResult(wire, effective, DECLINED_RESULT, true);
					continue;
				}
				// The registry owns dispatch and the two built-ins' argument
				// reading; a name no tool answers to is a failed outcome with a
				// sentence, never an exception out of the loop.
				// The turn's own context, not a store read: the loop already
				// holds the TinyFish key, so a tool execution cannot disagree
				// with the request that declared it.
				publishHostEvent("tool-called", { name: effective.name });
				const outcome = yield* executeTool(effective.name, effective, {
					tinyfishApiKey: ctx.tinyfishApiKey,
				});
				appendMarker(conversationId, assistantId, outcome.marker, raw);
				wire = appendToolResult(
					wire,
					{ ...effective, input: outcome.input },
					outcome.result,
					outcome.failed,
				);
			}
			// No rebuild between rounds: the next round replays this same
			// `wire`, which the provider rebuilds identically under
			// `skipUserMessage`, so the sent and stored bodies stay equal.
		}
	});

	// On success, seed the next turn with the reply appended so the model sees
	// its own prior answer (`[user, assistant, user]`, not `[user, user]`).
	// The turn forks on the subsystem's runtime, not a throwaway one: tool
	// execution resolves through the host's `tools` registry, which lives in
	// `HostServices`.
	activeFiber = runtime.runFork(
		Effect.exit(
			run.pipe(
				Effect.onExit((exit) =>
					Effect.gen(function* () {
						// Harvest the reply's blocks only while the feature is
						// live; off, the tag is prose, so there is nothing to
						// extract and nothing to store.
						const extracted: ExtractedMemories = memoryActive()
							? extractMemories(raw.value)
							: { text: raw.value, memories: [], malformed: false };
						// `afterReply` inspects or rewrites the final reply before
						// it is stored (spec §5). Only a successful turn has a
						// reply to rewrite; a failed or stopped turn ignores it.
						const reply = Exit.isSuccess(exit)
							? yield* runPipeline(
									"afterReply",
									displayText(raw.value.slice(finalTextStart)),
									meta,
								)
							: "";
						finalize(
							myRun,
							conversationId,
							protocol,
							exit,
							// The final round's text (memory tags stripped
							// while the feature is live), appended to the body
							// the tool loop extended.
							appendAssistant(wire, reply),
							extracted,
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
	publishHostEvent("turn-end", { conversationId, ok: false });
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
	// The title and its source are written together: a title alone is exactly
	// what a derived one looks like, and a model title must never replace a
	// deliberate one, so the source is the only thing that distinguishes them.
	updateConversation(id, (conversation) => ({
		...conversation,
		title,
		titleSource: "user",
	}));
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
	// registered protocol's entry for the conversation — the registry is the
	// list, so a plugin's protocol is pruned too.
	for (const protocol of protocolNames()) {
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

/**
 * Hand this store to the chat service (spec §5). The registration is an
 * inversion — `services.ts` cannot import this module without a boot cycle
 * (this module reaches the subsystem runtime through `providers.ts`) — so the
 * store points the service at itself once, at load. `host.chat` then reads and
 * drives exactly this store.
 */
registerChatStore({
	snapshot: getChat,
	send: (msg, parts) => send(msg, [...parts]),
	stop,
	newConversation,
	select: selectConversation,
	rename: renameConversation,
	remove: deleteConversation,
});
