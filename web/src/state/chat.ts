import { SendMsg } from "@lib/api";
import { type ChatMessage, type Conversation, db } from "@lib/db";
import { extractMemories, memoryPrompt, mergeMemories } from "@lib/memory";
import { type ProtocolName, protocolNames, providers } from "@lib/providers";
import { searchKindFor } from "@lib/providers/presets";
import type { AttachmentPart, Chunk, SendCtx } from "@lib/providers/types";
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
 * Last request body successfully sent, per conversation and protocol,
 * replayed as the base for that conversation's next turn. `Conversation`
 * persists only `ChatMessage`s, not the provider wire body, so this is
 * deliberately in-memory: it survives a switch within a session and
 * resets on reload (multi-turn context starts over). Keyed by
 * `${conversationId}\u0000${protocol}` so a protocol switch finds no
 * entry and falls back to the provider template instead of replaying a
 * body built for a different wire shape.
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

/**
 * Raw text accumulation shared with `appendChunk`. Memory tags are stripped
 * from the visible text, so the raw accumulation is the single source both
 * the visible text and the next-turn seed derive from: re-extracting over
 * the whole accumulation is idempotent, and a tag split across chunks still
 * never reaches the UI or the store.
 */
interface RawText {
	value: string;
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
				// The marker is display-only: the visible text (the next-turn
				// seed) accumulates `text` chunks only, so it never reaches the
				// wire. Trim trailing blank lines first so two adjacent calls
				// don't stack.
				const base = m.text.replace(/\n+$/, "");
				const sep = base === "" ? "" : "\n\n";
				return { ...m, text: `${base}${sep}${toolMarker(chunk.text)}\n\n` };
			}
			raw.value += chunk.text;
			return { ...m, text: extractMemories(raw.value).text };
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
		const text = Option.getOrElse(
			Cause.findErrorOption(exit.cause),
			() => "request failed",
		);
		updateConversation(conversationId, (conversation) => ({
			...conversation,
			messages: [
				...conversation.messages,
				{ id: nextMessageId(), role: "error", text },
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
	const prev = prevByConversationProtocol.get(
		prevKey(conversationId, protocol),
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
		systemPrompt: [conversation.systemPrompt ?? "", memory]
			.filter((part) => part !== "")
			.join("\n\n"),
	};

	// Body that would be sent *this* turn. The provider's own `send` builds the
	// identical request from the same ctx; we keep this — plus the streamed reply
	// appended on success — to seed the next turn.
	const nextBody = (
		provider.buildRequest as (send: unknown, ctx: SendCtx) => unknown
	)(prev ?? provider.template, ctx);
	const appendAssistant = provider.appendAssistant as (
		send: unknown,
		text: string,
	) => unknown;

	const myRun = ++runSeq;
	streamConversationId = conversationId;
	const assistantId = nextMessageId();
	updateConversation(conversationId, (c) => ({
		...c,
		title: deriveTitle(c, msg),
		messages: [
			...c.messages,
			{ id: nextMessageId(), role: "user", text: msg, parts },
			{ id: assistantId, role: "assistant", text: "" },
		],
	}));
	status = "streaming";
	refresh();

	// Raw accumulation of every `text` chunk. `appendChunk` derives the
	// visible text from it (extraction is idempotent), and the finalizer
	// harvests completed memory blocks once the stream settles.
	const raw: RawText = { value: "" };
	const run = Effect.gen(function* () {
		const stream = yield* SendMsg(protocol, ctx);
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.sync(() => {
				appendChunk(conversationId, assistantId, chunk, raw);
			}),
		);
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
							appendAssistant(nextBody, extracted.text),
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
