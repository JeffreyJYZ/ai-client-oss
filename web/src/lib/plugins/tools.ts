import { PluginFault } from "@lib/plugins/errors";
import { type Host, type HostRegistry, HostServices } from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import type { ToolCallData } from "@lib/providers/types";
import { Cause, Effect, Option, type Stream } from "effect";
import { z } from "zod";

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
 * The tool registry a plugin reaches as `host.tools` (spec §2/§5). `register`
 * is the **first-wins door**: built-ins register at boot, before any plugin
 * loads, so a plugin's same-name tool is refused with a `PluginFault` and the
 * built-in stays the one that resolves — a plugin cannot silently displace a
 * name the model already knows. Reads stay Effects/Streams because the model
 * loop and React drive them.
 */
export interface ToolRegistry {
	register(tool: Tool, pluginId?: string): Disposable;
	readonly entries: () => Effect.Effect<readonly ToolEntry[]>;
	readonly ownedBy: (owner: string) => Effect.Effect<readonly ToolEntry[]>;
	readonly changes: Stream.Stream<readonly ToolEntry[]>;
}

/**
 * The registry stores `ToolEntry`s, but `HostServices.tools` is typed as the
 * bare `RegistryEntry` (Task 3 left the non-`ui` kinds untyped). Only
 * {@link addTool} writes tools, so the narrowing is sound.
 */
const asToolEntry = (entry: RegistryEntry): ToolEntry => entry as ToolEntry;

/**
 * Validate `tool` and add it first-wins through `registry` (spec §5). The
 * declaration is validated because it is plugin-supplied and is serialized to
 * the model; `execute` is checked for callability because the loop invokes it —
 * a malformed tool is refused here rather than stored and defected on later.
 */
const addTool = (
	registry: HostRegistry<ToolEntry>,
	tool: Tool,
	pluginId?: string,
): Disposable => {
	// Read defensively: the caller is untyped JavaScript at this boundary.
	const declared = tool?.declaration as { readonly name?: unknown } | undefined;
	const declaration = toolDeclarationSchema.safeParse(declared);
	if (!declaration.success) {
		refuse(
			`the declaration for tool "${String(declared?.name)}" is invalid: ${declaration.error.message}`,
			pluginId,
		);
		return noopDisposable;
	}
	if (typeof tool.execute !== "function") {
		refuse(
			`the tool "${declaration.data.name}" has no callable execute; it was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	const name = declaration.data.name;
	const taken = Effect.runSync(registry.entries()).some(
		(entry) => entry.id === name,
	);
	if (taken) {
		refuse(
			`a tool named "${name}" is already registered; the later registration was refused`,
			pluginId,
		);
		return noopDisposable;
	}
	return registry.register({
		id: name,
		declaration: declaration.data,
		execute: tool.execute,
	});
};

/**
 * The typed `tools` registry bound to one plugin (spec §2's `host.tools`).
 * Registering through it is the same first-wins path `registerTool` uses, so
 * the public member and the registry agree — calling `host.tools.register`
 * directly cannot shadow a built-in.
 */
export const makeToolRegistry = (
	registry: HostRegistry<RegistryEntry>,
	pluginId: string,
): ToolRegistry => {
	// The registry holds `ToolEntry`s; only `addTool` writes them, so reading it
	// at that shape (rather than mapping every read back through `asToolEntry`)
	// is sound.
	const tools = registry as unknown as HostRegistry<ToolEntry>;
	return {
		register: (tool, label) => addTool(tools, tool, label ?? pluginId),
		entries: tools.entries,
		ownedBy: tools.ownedBy,
		changes: tools.changes,
	};
};

/**
 * Register `tool` through `host`, first wins (spec §5) — the shared seam the
 * built-ins and `host.tools.register` behind it use. `pluginId` is an optional
 * override for the refusal's label; the host stamps ownership either way.
 */
export const registerTool = (
	host: Host,
	tool: Tool,
	pluginId?: string,
): Disposable => host.tools.register(tool, pluginId);

/**
 * The registered tool called `name`, or `none` — the **entry**, not the bare
 * `Tool`: it carries `owner`, the plugin that registered it, so a caller that
 * isolates a fault can name the plugin alongside the tool (the same widening
 * `resolveProvider` makes, for the same reason).
 */
export const resolveTool = (
	name: string,
): Effect.Effect<Option.Option<ToolEntry>, never, HostServices> =>
	Effect.flatMap(HostServices, (services) =>
		Effect.map(services.tools.entries(), (entries) => {
			const found = entries.find((entry) => entry.id === name);
			return found === undefined
				? Option.none<ToolEntry>()
				: Option.some<ToolEntry>(asToolEntry(found));
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

/** The failed outcome a faulty executor is reported as (spec §9). */
const faultOutcome = (name: string, input: unknown): ToolOutcome => {
	const sentence = `The tool ${name} failed unexpectedly.`;
	return {
		result: sentence,
		marker: `🔧 ${name} failed unexpectedly`,
		failed: true,
		input,
	};
};

/**
 * Execute one tool call (spec §5). **Spec refinement, deliberate:** an unknown
 * name used to fall through into the fetch path, which existed only because
 * there were two tools and no registry; with a registry a miss is its own case
 * and fails with its own sentence. The invariant is preserved — a string result
 * either way, never an exception out of the loop.
 *
 * The execution is **failure-isolated** (spec §9): a third-party tool whose
 * `execute` throws, or returns a failed/defected effect, is a logged
 * `PluginFault` — naming the plugin that registered the tool, through
 * {@link resolveTool}'s entry — and a failed `ToolOutcome`, never a defect that
 * takes the turn down. An interruption is re-raised, so a stopped turn stays a
 * stop.
 *
 * `ctx` defaults to an empty context: the turn-scoped values (the TinyFish key)
 * are the caller's to pass, and the loop passes the turn's own context. The
 * default exists only so a caller that needs nothing (`executeTool(name, call)`)
 * need not build one.
 */
export const executeTool = (
	name: string,
	call: ToolCallData,
	ctx: ToolExecCtx = {},
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
		return yield* Effect.suspend(() => tool.value.execute(input, ctx)).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterrupts(cause)
					? Effect.failCause(cause)
					: Effect.andThen(
							Effect.logWarning(
								new PluginFault({
									detail: `the tool "${name}" faulted: ${Cause.pretty(cause)}`,
									pluginId: tool.value.owner,
								}),
							),
							Effect.succeed(faultOutcome(name, input)),
						),
			),
		);
	});
