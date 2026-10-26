import { z } from "zod";

/**
 * Every named UI region a contribution can render into — spec §4's slot
 * map, derived from today's component tree. One `as const` tuple per
 * registry so `z.enum` yields runtime validation and the union type from
 * a single declaration: adding a slot id here is one line, and it is
 * immediately valid wherever the schema is used (a manifest-adjacent
 * schema, `host.ui.*`).
 */
export const slotIds = [
	"ui.root.layout",
	"app.sidebar",
	"app.sidebar.actions",
	"app.header.title",
	"app.header.actions",
	"app.notices",
	"app.banner",
	"chat.pane",
	"chat.messages",
	"chat.message",
	"chat.message.actions",
	"chat.empty",
	"chat.stream-status",
	"composer.root",
	"composer.toolbar",
	"composer.actions",
	"settings.root",
	"settings.nav",
	"settings.sections",
	"settings.plugin.controls",
	"overlay.root",
	"command.palette.results",
] as const;

export const slotIdSchema = z.enum(slotIds);

export type SlotId = z.infer<typeof slotIdSchema>;

/**
 * Declared permission labels on a manifest (spec §7). They are honest
 * labels for consent and display, not enforcement — the label set here
 * is what the consent UI shows and what `manifestSchema` validates
 * against.
 */
export const capabilityIds = [
	"plugin-data",
	"net",
	"window",
	"shortcuts",
	"invoke",
	"fs-any",
] as const;

export const capabilitySchema = z.enum(capabilityIds);

export type Capability = z.infer<typeof capabilitySchema>;

/** Event names accepted by `host.on(...)` (spec §3's `PubSub` bus). */
export const hostEventNames = [
	"turn-start",
	"chunk",
	"turn-end",
	"conversation-changed",
	"settings-changed",
	"tool-called",
	"plugin-loaded",
	"plugin-unloaded",
] as const;

export const hostEventSchema = z.enum(hostEventNames);

export type HostEvent = z.infer<typeof hostEventSchema>;
