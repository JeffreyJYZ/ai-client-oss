import type { Logger } from "@lib/plugins/services";

/**
 * The plugin log panel's ring buffer (spec §2/§9). `host.log` reaches a plugin
 * as the scoped `Logger` `services.ts` builds; `host.ts` wraps that logger with
 * {@link reportingLogger} so every line a plugin logs is also kept here for the
 * Plugins section to show. The buffer is bounded, because an unbounded one is a
 * memory leak driven by plugin code.
 *
 * This module is deliberately free of imports from the host, the runtime or the
 * stores (the `Logger` type is a type-only import, erased at build): `host.ts`
 * imports it, `state/plugins.ts` imports it, and anything it imported back would
 * be a cycle in the middle of the boot path.
 */

/** The four levels `host.log` exposes. */
export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** One captured line. `seq` is the React key and the sort key. */
export interface PluginLogEntry {
	readonly seq: number;
	readonly pluginId: string | undefined;
	readonly level: PluginLogLevel;
	readonly message: string;
	readonly at: number;
}

/** How many lines are kept before the oldest are dropped. */
export const PLUGIN_LOG_LIMIT = 200;

let entries: readonly PluginLogEntry[] = [];
let seq = 0;

const listeners = new Set<() => void>();

const notify = (): void => {
	for (const listener of listeners) listener();
};

/**
 * Append one line, dropping the oldest past {@link PLUGIN_LOG_LIMIT}. Replaces
 * the snapshot array rather than mutating it, so the panel's
 * `useSyncExternalStore` read stays referentially stable between writes.
 */
export const recordLog = (
	pluginId: string | undefined,
	level: PluginLogLevel,
	message: string,
): void => {
	seq += 1;
	const next = [...entries, { seq, pluginId, level, message, at: Date.now() }];
	entries = next.slice(Math.max(0, next.length - PLUGIN_LOG_LIMIT));
	notify();
};

/** The current lines, oldest first. Stable between writes. */
export const getLogSnapshot = (): readonly PluginLogEntry[] => entries;

export const subscribeLog = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/** Drop every line. A no-op when empty, so it cannot wake a listener for nothing. */
export const clearLog = (): void => {
	if (entries.length === 0) return;
	entries = [];
	notify();
};

/**
 * Wrap a plugin's `Logger` so each call is recorded here *and* still logged by
 * the inner logger (the console). The record happens first: a console that
 * hangs or throws cannot cost the panel the line.
 */
export const reportingLogger = (
	pluginId: string | undefined,
	inner: Logger,
): Logger => ({
	debug: (message) => {
		recordLog(pluginId, "debug", message);
		inner.debug(message);
	},
	info: (message) => {
		recordLog(pluginId, "info", message);
		inner.info(message);
	},
	warn: (message) => {
		recordLog(pluginId, "warn", message);
		inner.warn(message);
	},
	error: (message) => {
		recordLog(pluginId, "error", message);
		inner.error(message);
	},
});
