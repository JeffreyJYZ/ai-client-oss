import { z } from "zod";

/**
 * The generated reference's data model. It is a zod schema like every other
 * value in the app, so the artifact the generator writes is parsed — by the
 * coverage gate and by anything else that reads it — rather than trusted, and
 * the page's props are `z.infer`red from the same declaration. Nothing here is
 * a hand-written API signature: every value is output of `scripts/build-docs.ts`.
 */
export const docSymbolSchema = z.object({
	/** The exported name, exactly as the source declares it. */
	name: z.string(),
	/** `const` | `let` | `function` | `class` | `interface` | `type` | `enum` | `namespace` | `re-export`. */
	kind: z.string(),
	/** Declaration text, generated from the source (a body is elided). */
	signature: z.string(),
	/** The leading doc comment, or `""`. */
	description: z.string(),
	/** Member names, for an interface, a class or an object type literal. */
	members: z.array(z.string()),
});
export type DocSymbol = z.infer<typeof docSymbolSchema>;

/**
 * One module in the reference. `documented` modules were read from disk at
 * generation time; a module the generator expects but cannot find is emitted as
 * `pending` rather than dropped, so the page can say what is not covered yet
 * instead of quietly omitting it.
 */
export const docModuleSchema = z.object({
	/** Path relative to `web/`, e.g. `src/lib/plugins/host.ts`. */
	path: z.string(),
	label: z.string(),
	summary: z.string(),
	status: z.enum(["documented", "pending"]),
	symbols: z.array(docSymbolSchema),
});
export type DocModule = z.infer<typeof docModuleSchema>;

/** One UI region from `slotIds` (spec §4's slot map). */
export const docSlotSchema = z.object({
	id: z.string(),
	description: z.string(),
});
export type DocSlot = z.infer<typeof docSlotSchema>;

/**
 * One capability label (spec §7). `boundary` is the honest classification the
 * consent UI shows: how far the label is actually enforced. There is no
 * "sandbox" value — a plugin runs in-process with the app's own privileges.
 */
export const docCapabilitySchema = z.object({
	id: z.string(),
	unlocks: z.string(),
	enforced: z.string(),
	boundary: z.enum(["path-scoped", "unenforceable", "consent-only"]),
});
export type DocCapability = z.infer<typeof docCapabilitySchema>;

/** One field of `manifestSchema`, read from its zod declaration. */
export const docFieldSchema = z.object({
	name: z.string(),
	/** The zod expression declaring it, verbatim from the source. */
	schema: z.string(),
	/** False when the schema has a `.default(...)` (or `.catch(...)`). */
	required: z.boolean(),
	description: z.string(),
});
export type DocField = z.infer<typeof docFieldSchema>;

/** One `host.on(...)` event name from `hostEventNames`. */
export const docEventSchema = z.object({
	name: z.string(),
	description: z.string(),
});
export type DocEvent = z.infer<typeof docEventSchema>;

/** The whole generated reference: the artifact and the page's only input. */
export const docReferenceSchema = z.object({
	/** `pluginApiVersion`, read from `host.ts`. */
	apiVersion: z.string(),
	/** The build's own version, from `web/package.json`. */
	appVersion: z.string(),
	modules: z.array(docModuleSchema),
	slots: z.array(docSlotSchema),
	capabilities: z.array(docCapabilitySchema),
	manifestFields: z.array(docFieldSchema),
	events: z.array(docEventSchema),
	/** Entry-list paths with no source on disk yet, named so the page can say so. */
	pending: z.array(z.string()),
	authorGuide: z.object({ available: z.boolean(), url: z.string() }),
});
export type DocReference = z.infer<typeof docReferenceSchema>;
