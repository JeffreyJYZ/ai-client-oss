import { SendMsg } from "@lib/api";
import { type ProtocolName, providers } from "@lib/providers";
import type { AttachmentPart, SendCtx } from "@lib/providers/types";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { getSettings } from "./settings";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "error";
	text: string;
	parts?: AttachmentPart[];
}

export type ChatStatus = "idle" | "streaming";

export interface ChatSnapshot {
	readonly messages: readonly ChatMessage[];
	readonly status: ChatStatus;
}

/**
 * Last request body successfully sent, replayed as the base for the next turn.
 * `undefined` until the first send completes; provider (`buildRequest`) folds the
 * new user turn into it, which is what gives the conversation its multi-turn context.
 */
let prev: unknown;

let activeFiber: Fiber.Fiber<Exit.Exit<void, string>, never> | undefined;

let seq = 0;
const nextId = (): string => `msg-${++seq}`;

let state: ChatSnapshot = { messages: [], status: "idle" };

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const cb of listeners) cb();
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

const appendText = (id: string, text: string): void => {
	state = {
		messages: state.messages.map((m) =>
			m.id === id ? { ...m, text: m.text + text } : m,
		),
		status: state.status,
	};
	notify();
};

const finalize = (exit: Exit.Exit<void, string>, next: unknown): void => {
	if (Exit.isSuccess(exit)) {
		prev = next;
	} else if (!Cause.hasInterruptsOnly(exit.cause)) {
		const text = Option.getOrElse(
			Cause.findErrorOption(exit.cause),
			() => "request failed",
		);
		state = {
			messages: [...state.messages, { id: nextId(), role: "error", text }],
			status: "idle",
		};
		notify();
		return;
	}
	state = { messages: state.messages, status: "idle" };
	notify();
};

export const send = (msg: string, parts: AttachmentPart[]): void => {
	if (state.status === "streaming") return;
	if (msg.trim() === "" && parts.length === 0) return;

	const settings = getSettings();
	const protocol: ProtocolName = settings.provider;
	const provider = providers[protocol];

	const ctx: SendCtx = {
		msg,
		prev,
		apiUrl: settings.baseUrl,
		apiKey: settings.apiKey,
		parts,
		tools: settings.tools,
	};

	// Body that would be sent *this* turn. The provider's own `send` builds the
	// identical request from the same ctx; we keep this only to seed the next turn.
	const nextBody = (
		provider.buildRequest as (send: unknown, ctx: SendCtx) => unknown
	)(prev ?? provider.template, ctx);

	const assistantId = nextId();
	state = {
		messages: [
			...state.messages,
			{ id: nextId(), role: "user", text: msg, parts },
			{ id: assistantId, role: "assistant", text: "" },
		],
		status: "streaming",
	};
	notify();

	const run = Effect.gen(function* () {
		const stream = yield* SendMsg(protocol, ctx);
		yield* Stream.runForEach(stream, (chunk) =>
			Effect.sync(() => appendText(assistantId, chunk.text)),
		);
	});

	activeFiber = Effect.runFork(
		Effect.exit(
			run.pipe(
				Effect.onExit((exit) => Effect.sync(() => finalize(exit, nextBody))),
			),
		),
	);
};

export const stop = (): void => {
	const fiber = activeFiber;
	activeFiber = undefined;
	if (fiber !== undefined) {
		Effect.runFork(Fiber.interrupt(fiber));
	}
	state = { messages: state.messages, status: "idle" };
	notify();
};
