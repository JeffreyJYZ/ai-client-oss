import { Data } from "effect";

/**
 * Every failure the plugin subsystem fails an Effect with (spec §9). One
 * tagged class per failure mode so recovery is `Effect.catchTag`, and so
 * an unknown handler can never silently match. `detail` is a sentence fit
 * to show in the Plugins section; `pluginId` names the plugin at fault
 * when one is known.
 */
export class ManifestInvalid extends Data.TaggedError("ManifestInvalid")<{
	readonly detail: string;
	readonly pluginId?: string;
}> {}

/** `plugin.json` could not be read or decoded. */
export class PluginLoadFailed extends Data.TaggedError("PluginLoadFailed")<{
	readonly detail: string;
	readonly pluginId?: string;
}> {}

/** Plugin code misbehaved at runtime — a registration or render fault. */
export class PluginFault extends Data.TaggedError("PluginFault")<{
	readonly detail: string;
	readonly pluginId?: string;
}> {}

/**
 * The manifest's `apiVersion` major differs from the host's, so the
 * plugin is refused rather than loaded against an API it was not built
 * for (spec §10).
 */
export class ApiVersionIncompatible extends Data.TaggedError(
	"ApiVersionIncompatible",
)<{
	readonly detail: string;
	readonly pluginId?: string;
}> {}

/** A host call named a capability the manifest did not declare. */
export class CapabilityUnknown extends Data.TaggedError("CapabilityUnknown")<{
	readonly detail: string;
	readonly pluginId?: string;
}> {}

/** The subsystem's error channel: every failure is one of these five. */
export type PluginError =
	| ManifestInvalid
	| PluginLoadFailed
	| PluginFault
	| ApiVersionIncompatible
	| CapabilityUnknown;
