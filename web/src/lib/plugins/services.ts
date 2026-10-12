import { PluginFault } from "@lib/plugins/errors";
import { type HostEvent, hostEventSchema } from "@lib/plugins/ids";
import {
	PLUGIN_DATA_MAX_BYTES,
	pluginDataWithinCap,
} from "@lib/plugins/manifest";
import type { Disposable } from "@lib/plugins/registry";
import type { AttachmentPart } from "@lib/providers/types";
import { Cause, Effect, Option, PubSub, Stream } from "effect";
import type { ChatSnapshot } from "@/state/chat";
import {
	getSettings,
	setSettings,
	subscribe as subscribeSettings,
} from "@/state/settings";

/**
 * The host services a plugin calls for behaviour (spec §2/§3/§5): the chat
 * store, the scoped per-plugin storage, the event bus behind `host.on`, the
 * logger, and the desktop `native` handle. `host.db` is the app's own adapter
 * instance, so this module does not wrap it — it is re-exported onto `Host` by
 * `host.ts`.
 *
 * Two of these are deliberately **module state, not `HostServices` members**:
 * the event bus and the chat store are reached synchronously from `state/chat.ts`
 * and `state/settings.ts` on every turn and every settings change, and those
 * modules cannot run an Effect to reach a service. A plain module-level sink is
 * what lets a synchronous publisher reach an Effect-free subscriber list.
 *
 * **Why the chat store is an inversion.** `state/chat.ts` imports
 * `@lib/plugins/providers`, which owns the subsystem's one `ManagedRuntime`;
 * this module is imported by `host.ts`, which that runtime is built from. A
 * direct `services.ts → state/chat.ts` import is a module cycle that evaluates
 * `ManagedRuntime.make(HostLayer)` before `HostLayer` exists and throws
 * (`Cannot access 'HostLayer' before initialization`) before React mounts. So
 * the chat store registers itself into this module at load; the dependency
 * points one way only.
 */

/** An inert handle for a refused subscription; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/**
 * A refused host call is a logged `PluginFault`, never a throw (spec §9): the
 * plugin's call is dropped, the plugin and the app keep running.
 */
const warn = (detail: string, pluginId?: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

/* ------------------------------------------------------------------ storage */

/**
 * Per-plugin key/value storage (spec §5), persisted inside
 * `Settings.plugins[].data` so it rides the existing backup and needs no
 * `lib/backup.ts` change. `set`/`delete` write through the store's existing
 * `setSettings` patch path, which is the one write seam the rest of the app
 * uses. A plugin never names another plugin: the id is bound at construction.
 */
export interface ScopedStorage {
	readonly get: (key: string) => Effect.Effect<Option.Option<unknown>>;
	readonly set: (key: string, value: unknown) => Effect.Effect<void>;
	readonly delete: (key: string) => Effect.Effect<void>;
	readonly keys: () => Effect.Effect<readonly string[]>;
}

/** This plugin's stored `data`, or an empty record when it has no entry yet. */
const readData = (pluginId: string): Record<string, unknown> =>
	getSettings().plugins.find((plugin) => plugin.id === pluginId)?.data ?? {};

/**
 * Persist `data` under `pluginId`, creating the plugin's `Settings.plugins[]`
 * entry when storage is used before the loader has enabled it. Every other
 * plugin's entry is preserved — the patch replaces the whole array, so it is
 * rebuilt from the live one.
 */
const writeData = (pluginId: string, data: Record<string, unknown>): void => {
	const plugins = getSettings().plugins;
	const known = plugins.some((plugin) => plugin.id === pluginId);
	setSettings({
		plugins: known
			? plugins.map((plugin) =>
					plugin.id === pluginId ? { ...plugin, data } : plugin,
				)
			: [
					...plugins,
					{
						id: pluginId,
						enabled: false,
						version: "",
						capabilities: [],
						data,
					},
				],
	});
};

/** The storage service bound to one plugin's id (spec §2's `host.storage`). */
export const makeScopedStorage = (pluginId: string): ScopedStorage => ({
	get: (key) =>
		Effect.sync(() => {
			const data = readData(pluginId);
			return key in data ? Option.some(data[key]) : Option.none<unknown>();
		}),
	set: (key, value) =>
		Effect.sync(() => {
			const next = { ...readData(pluginId), [key]: value };
			if (!pluginDataWithinCap(next)) {
				warn(
					`storage for plugin "${pluginId}" would exceed the per-plugin cap of ${PLUGIN_DATA_MAX_BYTES} bytes; the write to "${key}" was refused`,
					pluginId,
				);
				return;
			}
			writeData(pluginId, next);
		}),
	delete: (key) =>
		Effect.sync(() => {
			const data = readData(pluginId);
			if (!(key in data)) return;
			const next = { ...data };
			delete next[key];
			writeData(pluginId, next);
		}),
	keys: () => Effect.sync(() => Object.keys(readData(pluginId))),
});

/* ------------------------------------------------------------------- events */

/** One live subscription to the bus. */
interface Subscription {
	readonly handler: (payload: unknown) => void;
}

/** Every subscriber, keyed by the event it asked for. */
const subscribers = new Map<HostEvent, Set<Subscription>>();

/**
 * Subscribe `handler` to `event` (spec §3's `PubSub` bus, exposed as
 * `host.on`). The returned handle stops exactly this subscription; the host
 * attaches its disposal to the plugin's `Scope`, so unload drops the handler.
 * An unknown event name or a non-function handler is refused as a logged
 * `PluginFault` — a plugin is untyped at this boundary.
 */
export const subscribeHostEvent = (
	event: HostEvent,
	handler: (payload: unknown) => void,
	pluginId?: string,
): Disposable => {
	const parsed = hostEventSchema.safeParse(event);
	if (!parsed.success || typeof handler !== "function") {
		warn(
			`host.on: "${String(event)}" is not a known event, or the handler is not a function; the subscription was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	const subscription: Subscription = { handler };
	const set = subscribers.get(parsed.data) ?? new Set<Subscription>();
	set.add(subscription);
	subscribers.set(parsed.data, set);
	return {
		dispose: () => {
			set.delete(subscription);
		},
	};
};

/**
 * Publish one event to every current subscriber (spec §9). This is the
 * synchronous seam `state/chat.ts` and the stores call on every turn; each
 * handler runs in its own isolated step, so a handler that throws is a logged
 * `PluginFault` and the remaining handlers still see the event.
 */
export const publishHostEvent = (event: HostEvent, payload: unknown): void => {
	const set = subscribers.get(event);
	if (set === undefined) return;
	for (const subscription of [...set]) {
		Effect.runSync(
			Effect.sync(() => subscription.handler(payload)).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						new PluginFault({
							detail: `a "${event}" subscriber faulted and was skipped: ${Cause.pretty(cause)}`,
						}),
					),
				),
			),
		);
	}
};

/* --------------------------------------------------------------------- chat */

/**
 * The chat store this module reads and drives (spec §5). The app's own store
 * (`state/chat.ts`) registers it at module load; see this file's header for why
 * the registration is an inversion rather than an import.
 */
export interface ChatStore {
	readonly snapshot: () => ChatSnapshot;
	readonly send: (msg: string, parts: readonly AttachmentPart[]) => void;
	readonly stop: () => void;
	readonly newConversation: () => void;
	readonly select: (id: string) => void;
	readonly rename: (id: string, title: string) => void;
	readonly remove: (id: string) => void;
}

let chatStore: ChatStore | undefined;

/** Point the chat service at the app's chat store. Called once, at load. */
export const registerChatStore = (store: ChatStore): void => {
	chatStore = store;
};

/**
 * The chat service a plugin reads and drives (spec §2's `host.chat`). Reads are
 * synchronous (a snapshot), mutations return `Effect`s (spec §2: the
 * sync/Effect split is visible in the signature), and `changes` is the
 * `Stream` a plugin subscribes to.
 */
export interface ChatService {
	readonly snapshot: () => ChatSnapshot;
	readonly changes: Stream.Stream<ChatSnapshot>;
	readonly send: (
		msg: string,
		parts?: readonly AttachmentPart[],
	) => Effect.Effect<void>;
	readonly stop: () => Effect.Effect<void>;
	readonly newConversation: () => Effect.Effect<void>;
	readonly select: (id: string) => Effect.Effect<void>;
	readonly rename: (id: string, title: string) => Effect.Effect<void>;
	readonly delete: (id: string) => Effect.Effect<void>;
}

/** The snapshot a fresh service reports before the store has registered. */
const emptyChat: ChatSnapshot = {
	conversations: [],
	activeId: "",
	messages: [],
	status: "idle",
	systemPrompt: "",
	hydrated: false,
};

/**
 * The chat snapshot stream (spec §3). `replay: 1` seeds a late subscriber with
 * the current snapshot, so a `host.chat.changes` subscriber that arrives after
 * the first turn still sees the latest state rather than nothing.
 */
const chatChanges = Effect.runSync(
	PubSub.unbounded<ChatSnapshot>({ replay: 1 }),
);

/** Push a snapshot to every `host.chat.changes` subscriber, synchronously. */
export const publishChatSnapshot = (snapshot: ChatSnapshot): void => {
	PubSub.publishUnsafe(chatChanges, snapshot);
};

/** The chat service bound to the registered store (spec §2's `host.chat`). */
export const makeChatService = (): ChatService => {
	const run = (use: (store: ChatStore) => void): Effect.Effect<void> =>
		Effect.sync(() => {
			if (chatStore !== undefined) use(chatStore);
		});
	return {
		snapshot: () => chatStore?.snapshot() ?? emptyChat,
		changes: Stream.fromPubSub(chatChanges),
		send: (msg, parts = []) => run((store) => store.send(msg, parts)),
		stop: () => run((store) => store.stop()),
		newConversation: () => run((store) => store.newConversation()),
		select: (id) => run((store) => store.select(id)),
		rename: (id, title) => run((store) => store.rename(id, title)),
		delete: (id) => run((store) => store.remove(id)),
	};
};

/* ------------------------------------------------------------------ logging */

/** The logging surface a plugin gets as `host.log` (spec §2). */
export interface Logger {
	readonly info: (message: string) => void;
	readonly warn: (message: string) => void;
	readonly error: (message: string) => void;
	readonly debug: (message: string) => void;
}

/** The logger bound to one plugin, so its lines name it in the console. */
export const makeLogger = (pluginId?: string): Logger => {
	const tagged = (message: string): string =>
		pluginId === undefined ? message : `[${pluginId}] ${message}`;
	return {
		info: (message) => {
			Effect.runSync(Effect.logInfo(tagged(message)));
		},
		warn: (message) => {
			Effect.runSync(Effect.logWarning(tagged(message)));
		},
		error: (message) => {
			Effect.runSync(Effect.logError(tagged(message)));
		},
		debug: (message) => {
			Effect.runSync(Effect.logDebug(tagged(message)));
		},
	};
};

/* ------------------------------------------------------------------- native */

/**
 * The desktop-only native surface (spec §7): the scoped data directory and the
 * file commands the Tauri bridge exposes. Task 20 supplies a real handle; until
 * then `host.native` is `Option.none()`, so a plugin checks the `Option` rather
 * than calling a method that silently does nothing.
 */
export interface NativeHandle {
	/** Absolute path of the plugin's scoped data directory (spec §7). */
	readonly dataDir: string;
}

/** The native handle, absent until the desktop bridge lands (Task 20). */
export const nativeHandle: Option.Option<NativeHandle> = Option.none();

/**
 * The settings store's one change path is `subscribe`, so subscribing here
 * makes `host.on("settings-changed")` see every settings change — the user's,
 * and a plugin's own storage write. Published at load, before any plugin can
 * subscribe, so no change is missed by a subscriber that arrives later.
 */
subscribeSettings(() => {
	publishHostEvent("settings-changed", getSettings());
});

/** The snapshot type `host.chat` reads and streams, re-exported for plugins. */
export type { ChatSnapshot };
