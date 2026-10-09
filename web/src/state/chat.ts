import { SendMsg } from "@lib/api";
import { type ChatMessage, type Conversation, db } from "@lib/db";
import { type ProtocolName, protocolNames, providers } from "@lib/providers";
import type { AttachmentPart, Chunk, SendCtx } from "@lib/providers/types";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { getActiveProvider } from "./settings";

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
 * Append one streamed chunk to the assistant message, routed by `kind`:
 * `reasoning` (thinking) lands in `reasoning`, `text` (the answer) in `text`,
 * so the two never concatenate into one squished bubble.
 */
const appendChunk = (
	conversationId: string,
	messageId: string,
	chunk: Chunk,
): void => {
	updateConversation(conversationId, (conversation) => ({
		...conversation,
		messages: conversation.messages.map((m) => {
			if (m.id !== messageId) return m;
			return chunk.kind === "reasoning"
				? { ...m, reasoning: (m.reasoning ?? "") + chunk.text }
				: { ...m, text: m.text + chunk.text };
		}),
	}));
	refresh();
};

const finalize = (
	myRun: number,
	conversationId: string,
	protocol: ProtocolName,
	exit: Exit.Exit<void, string>,
	next: unknown,
): void => {
	// A newer send (or a `stop`) invalidated this run; its finalizer must not
	// touch shared state, or it would clobber the new stream's status/`prev`.
	if (myRun !== runSeq) return;
	activeFiber = undefined;
	streamConversationId = undefined;
	if (Exit.isSuccess(exit)) {
		prevByConversationProtocol.set(prevKey(conversationId, protocol), next);
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
		systemPrompt: conversation.systemPrompt,
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

	let assistantText = "";
	const run = Effect.gen(function* () {
		const stream = yield* SendMsg(protocol, ctx);
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.sync(() => {
				// Only the answer seeds the next turn; reasoning is display-only.
				if (chunk.kind === "text") assistantText += chunk.text;
				appendChunk(conversationId, assistantId, chunk);
			}),
		);
	});

	// On success, seed the next turn with the reply appended so the model sees
	// its own prior answer (`[user, assistant, user]`, not `[user, user]`).
	activeFiber = Effect.runFork(
		Effect.exit(
			run.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() =>
						finalize(
							myRun,
							conversationId,
							protocol,
							exit,
							appendAssistant(nextBody, assistantText),
						),
					),
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
