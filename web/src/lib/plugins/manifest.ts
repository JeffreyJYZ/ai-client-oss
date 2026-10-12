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
