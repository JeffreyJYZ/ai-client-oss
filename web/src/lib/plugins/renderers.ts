import { PluginFault } from "@lib/plugins/errors";
import type { Disposable, Host } from "@lib/plugins/host";
import { Effect } from "effect";
import type { ComponentType } from "react";
import { z } from "zod";

/**
 * Renderer overrides (spec §5): a plugin can replace how a message, its
 * markdown body, its marker interleave or its reasoning block renders, without
 * replacing the whole message. This module is the typed API over the `ui`
 * registry `useComponent` already resolves from, not a second registry beside
 * it — one home for the resolution, which is why the built-ins (registered by
 * `builtin/transcript.ts`) and an override are read through the same call.
 *
 * **The id convention carries the override semantics.** The built-in for a kind
 * is registered at `ui.<kind>`; an override registers at `<kind>`, with a
 * higher `priority` (spec §4: highest priority wins, else the built-in).
 * Because those are different ids, the registry's replace-in-place rule does
 * not apply: disposing the override — a plugin unload closes its `Scope` —
 * leaves the built-in resolvable, instead of removing the renderer entirely.
 * Registering the override at `ui.<kind>` would do exactly that and blank the
 * region, so do not "simplify" the ids into one.
 */

/** The four renderers a plugin may override (spec §5). */
export const rendererKinds = [
	"message",
	"markdown",
	"marker",
	"reasoning",
] as const;

/** The zod schema for a renderer kind — the union's single declaration (spec §1). */
export const rendererKindSchema = z.enum(rendererKinds);

/** One overridable renderer kind. */
export type RendererKind = z.infer<typeof rendererKindSchema>;

/**
 * The override's priority. The built-in registers with no priority (resolved as
 * 0), so any override outranks it while an *absent* override leaves the
 * built-in in place — the property the distinct-id convention above buys.
 */
const overridePriority = 1;

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/** A refused registration is a logged `PluginFault`, never a throw (spec §9). */
const warn = (detail: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail })));
};

/**
 * Register `component` as the override for `kind` through `host` (spec §5). The
 * entry lands in the `ui` registry at `chat.message` — the region the built-in
 * renderers already declare — so `ui/Message.tsx`'s `useComponent("ui.markdown")`
 * resolves it on the next render, and disposing the returned handle restores the
 * built-in.
 */
export const registerRenderer = (
	host: Host,
	kind: RendererKind,
	component: ComponentType<Record<string, unknown>>,
): Disposable => {
	const parsed = rendererKindSchema.safeParse(kind);
	if (!parsed.success) {
		warn(
			`renderers.register: "${String(kind)}" is not a renderer kind (${rendererKinds.join(", ")}); the override was refused`,
		);
		return noopDisposable;
	}
	if (typeof component !== "function") {
		warn(
			`renderers.register: the "${parsed.data}" override is not a component; it was refused`,
		);
		return noopDisposable;
	}
	return host.ui.register({
		id: parsed.data,
		slot: "chat.message",
		component,
		priority: overridePriority,
	});
};

/** What a plugin calls to override a renderer (spec §5's `renderers.register`). */
export interface RendererRegistry {
	register(
		kind: RendererKind,
		component: ComponentType<Record<string, unknown>>,
	): Disposable;
}

/**
 * The renderer registry bound to one plugin's `host`, the shape
 * `host.renderers` takes (spec §2). A thin typing of {@link registerRenderer}:
 * registering through it is registering a contribution, so ownership and
 * disposal are the registry's own.
 */
export const makeRendererRegistry = (host: Host): RendererRegistry => ({
	register: (kind, component) => registerRenderer(host, kind, component),
});
