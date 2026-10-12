import { PluginFault } from "@lib/plugins/errors";
import { type Host, HostServices } from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import type { ToolCallData } from "@lib/providers/types";
import { Effect, Option } from "effect";
import { z } from "zod";
import { getSettings } from "@/state/settings";

/**
 * The tool registry (spec §5). A tool is a **declaration** — the name,
 * description and JSON Schema the model is handed — plus the **executor** that
 * runs when the model calls it. The declaration is zod because it is serialized
 * to the model, and a plugin is untyped JavaScript at this boundary: the
 * registry validates it on the way in rather than trusting it.
 *
 * Storage is the host's own `tools` registry (`HostServices`), so a tool
 * registered here is owned and disposed by the registering plugin's `Scope` —
 * the same lifetime every other contribution has. Only this module writes
 * tools, which is what makes the narrowing in `asToolEntry` sound.
 */

/**
 * A tool's wire declaration (spec §1): what the model is told it may call. The
 * `parameters` half is JSON Schema, sent verbatim, so it stays `unknown`-valued
 * here rather than being re-modelled.
 */
export const toolDeclarationSchema = z.object({
	/** The tool's wire name: what the model calls and what the loop resolves. */
	name: z.string().min(1),
	description: z.string(),
	/** JSON Schema for the call's arguments. */
	parameters: z.record(z.string(), z.unknown()),
});

export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

/**
 * What a tool execution needs from the turn it runs in (spec §5). Today that is
 * the TinyFish key, which backs both the client-side search and the fetch-first
 * route; a tool that needs nothing simply ignores the argument.
 */
export interface ToolExecCtx {
	readonly tinyfishApiKey?: string;
}

/**
 * One executed tool call (spec §5): the text the model reads, the marker the
 * transcript shows for it, whether it failed, and the call's arguments parsed
 * to a value (the loop writes them back into the replayed wire body).
 */
export interface ToolOutcome {
	readonly result: string;
	readonly marker: string;
	readonly failed: boolean;
	readonly input: unknown;
}

/** A tool as a plugin declares it: the wire declaration plus the executor. */
export interface Tool {
	readonly declaration: ToolDeclaration;
	readonly execute: (
		input: unknown,
		ctx: ToolExecCtx,
	) => Effect.Effect<ToolOutcome>;
}

/**
 * The entry a `Tool` is stored as (spec §2): `RegistryEntry`'s identity and
 * ownership plus the tool's own fields. `id` is the declaration's wire name, so
 * a call resolves by name and registration order is resolution order.
 */
export interface ToolEntry extends RegistryEntry, Tool {}

/** An inert handle for a refused registration; disposing it is a no-op. */
const noopDisposable: Disposable = { dispose: () => {} };

/**
 * A registration refused for a bad value is a logged `PluginFault`, never a
 * throw (spec §9): one tool is dropped, the plugin and the app keep running.
 */
const refuse = (detail: string, pluginId?: string): void => {
	Effect.runSync(Effect.logWarning(new PluginFault({ detail, pluginId })));
};

/**
 * Register `tool` through `host`, first wins (spec §5). Built-ins register at
 * boot, before any plugin loads, so a plugin's same-name tool is refused with a
 * `PluginFault` and the built-in stays the one that resolves — a plugin cannot
 * silently displace a name the model already knows. `pluginId` names the
 * refusing plugin in that fault; the built-in registrar omits it, since it
 * registers first and can never collide.
 *
 * The declaration is validated here because the value is plugin-supplied: a
 * malformed declaration is refused rather than stored and serialized.
 */
export const registerTool = (
	host: Host,
	tool: Tool,
	pluginId?: string,
): Disposable => {
	// Read defensively: the caller is untyped JavaScript at this boundary.
	const declared = tool.declaration as { readonly name?: unknown } | undefined;
	const declaration = toolDeclarationSchema.safeParse(declared);
	if (!declaration.success) {
		refuse(
			`the declaration for tool "${String(declared?.name)}" is invalid: ${declaration.error.message}`,
			pluginId,
		);
		return noopDisposable;
	}
	const name = declaration.data.name;
	const taken = Effect.runSync(host.tools.entries()).some(
		(entry) => entry.id === name,
	);
	if (taken) {
		refuse(
			`a tool named "${name}" is already registered; the later registration was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	const entry: Omit<ToolEntry, "owner"> = {
		id: name,
		declaration: declaration.data,
		execute: tool.execute,
	};
	return host.tools.register(entry);
};

/**
 * The registry stores `ToolEntry`s, but `HostServices.tools` is typed as the
 * bare `RegistryEntry` (Task 3 left the non-`ui` kinds untyped). Only
 * `registerTool` writes tools, so the narrowing is sound.
 */
const asToolEntry = (entry: RegistryEntry): ToolEntry => entry as ToolEntry;

/** The registered tool called `name`, or `none`. */
export const resolveTool = (
	name: string,
): Effect.Effect<Option.Option<Tool>, never, HostServices> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.map(services.tools.entries(), (entries) => {
			const found = entries.find((entry) => entry.id === name);
			return found === undefined
				? Option.none<Tool>()
				: Option.some<Tool>(asToolEntry(found));
		}),
	);

/**
 * The call's arguments parsed to a value, or `null` when they are not JSON at
 * all — a parse failure is `null` here, not a failed effect: the call still
 * runs, and fails, as a missing argument.
 */
const parseArguments = (call: ToolCallData): Effect.Effect<unknown> =>
	Effect.orElseSucceed(
		Effect.try({
			try: () => JSON.parse(call.args) as unknown,
			catch: () => "arguments were not JSON",
		}),
		() => null,
	);

/** The marker line a call to an unregistered tool leaves in the transcript. */
const unknownToolMarker = (name: string, sentence: string): string =>
	`🔧 ${name} failed: ${sentence}`;

/**
 * The turn context an execution runs in when the caller supplies none: the
 * user's TinyFish key, the one turn-scoped value the built-ins read. The loop
 * relies on this default; a test (or a future chat service) passes its own.
 */
const ambientExecCtx = (): ToolExecCtx => ({
	tinyfishApiKey: getSettings().tinyfishApiKey,
});

/**
 * Execute one tool call (spec §5). **Spec refinement, deliberate:** an unknown
 * name used to fall through into the fetch path, which existed only because
 * there were two tools and no registry; with a registry a miss is its own case
 * and fails with its own sentence. The invariant is preserved — a string result
 * either way, never an exception out of the loop.
 */
export const executeTool = (
	name: string,
	call: ToolCallData,
	ctx: ToolExecCtx = ambientExecCtx(),
): Effect.Effect<ToolOutcome, never, HostServices> =>
	Effect.gen(function* () {
		const input = yield* parseArguments(call);
		const tool = yield* resolveTool(name);
		if (Option.isNone(tool)) {
			const sentence = `No tool named ${name} is registered.`;
			return {
				result: sentence,
				marker: unknownToolMarker(name, sentence),
				failed: true,
				input,
			};
		}
		return yield* tool.value.execute(input, ctx);
	});
