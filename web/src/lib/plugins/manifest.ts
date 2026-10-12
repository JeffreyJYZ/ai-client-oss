import { capabilitySchema } from "@lib/plugins/ids";
import { z } from "zod";

/**
 * `plugin.json` — the only thing parsed from disk (spec §6). Identity and
 * version are non-empty strings; the loader checks `apiVersion`'s major
 * and `engines.app` separately (spec §10), so they stay plain strings
 * here. Defaults make a manifest minimal: only `id`, `name`, `version`
 * and `apiVersion` are required.
 */
export const manifestSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	version: z.string().min(1),
	apiVersion: z.string(),
	entry: z.string().default("main.js"),
	/** Validated against the declared capability labels, so a typo fails the manifest. */
	capabilities: z.array(capabilitySchema).default([]),
	/** App version range the plugin declares it runs on; `*` accepts anything. */
	engines: z.object({ app: z.string().default("*") }).default({ app: "*" }),
	description: z.string().default(""),
	author: z.string().default(""),
	homepage: z.string().default(""),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

/**
 * Per-plugin persisted state, nested in `Settings` (spec §8). `capabilities`
 * is a plain string list — it records what the manifest declared at
 * enable time for display, and is never re-validated here. `data` is the
 * plugin's own storage, so later tasks can write whatever shape they
 * need without a schema change.
 */
export const pluginStateSchema = z.object({
	id: z.string(),
	enabled: z.boolean(),
	version: z.string(),
	capabilities: z.array(z.string()),
	data: z.record(z.string(), z.unknown()),
});

export type PluginState = z.infer<typeof pluginStateSchema>;

/**
 * Per-plugin ceiling, in bytes, for `pluginStateSchema.data`. A full-trust
 * plugin's `data` rides `settings.json` and every backup, so one plugin must
 * not be able to balloon either to unusable size (spec §13, "Plugin-owned
 * data"). Measured on the JSON-serialised value — the bytes actually persisted.
 */
export const PLUGIN_DATA_MAX_BYTES = 64 * 1024;

/**
 * Whether a plugin's `data` is within {@link PLUGIN_DATA_MAX_BYTES}. Pure.
 * The storage service (Task 16) must call this on the write path and reject a
 * write that returns false; it is a guard, not a schema constraint, because
 * `pluginStateSchema.data` stays an open record. A value that serialises to
 * UTF-8 beyond the cap (or to nothing at all) is out of bounds.
 */
export const pluginDataWithinCap = (data: unknown): boolean => {
	const serialised = JSON.stringify(data);
	if (serialised === undefined) return false;
	return new TextEncoder().encode(serialised).length <= PLUGIN_DATA_MAX_BYTES;
};
