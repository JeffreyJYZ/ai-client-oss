import type {
	Host,
	PipelineEntry,
	Tool,
	ToolExecCtx,
	ToolOutcome,
} from "@lib/plugins/sdk";
import { Effect } from "effect";

/**
 * custom-tool — a model-callable tool, and the tool-call hook (spec §5).
 *
 * What it proves:
 *
 * - **`tools.register` announces the tool to the model**: the request body's
 *   `tools` array is built by `requestTools` in `lib/providers/presets.ts`,
 *   which reads the host's tools registry — so the declaration below (the name,
 *   description and JSON Schema the model is handed) reaches the wire without
 *   the plugin doing anything but registering;
 * - **execution end to end**: when the model emits a call for `shout`, the loop
 *   resolves it through the registry, runs the executor, and feeds the result
 *   back into the replayed body — paired with the call by its `tool_call_id`;
 * - **the `onToolCall` pre-flight hook**: a pipeline stage may veto a call. A
 *   vetoed call still records a result, so the replayed body never carries a
 *   `tool_call` without its matching result (the dangling-call 400), and the
 *   turn survives.
 *
 * A plugin cannot declare a tool on the wire itself: `buildRequest` re-runs
 * inside `SendMsg` and rebuilds `tools` from host policy plus the registry, so
 * a `transformBody` stage that appends a declaration is overwritten before the
 * request is sent. Registration is the one mechanism, which is why this example
 * registers and declares nothing else.
 */

const TOOL_NAME = "shout";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** The declaration the model is handed — a full JSON Schema for the arguments. */
const toolDeclaration = {
	name: TOOL_NAME,
	description:
		"Uppercase the given text. Call this whenever the user asks for shouting.",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string", description: "The text to shout." },
		},
		required: ["text"],
	},
} as const;

/** Run one call. Every failure is a failed `ToolOutcome`, never a throw. */
const execute = (
	input: unknown,
	_ctx: ToolExecCtx,
): Effect.Effect<ToolOutcome> =>
	Effect.sync(() => {
		const text =
			isRecord(input) && typeof input.text === "string" ? input.text : "";
		if (text === "") {
			const sentence = `${TOOL_NAME} was called without any text.`;
			return {
				result: sentence,
				marker: `🔧 ${sentence}`,
				failed: true,
				input,
			};
		}
		const shouted = text.toUpperCase();
		return {
			result: shouted,
			marker: `🔧 ${TOOL_NAME} → ${shouted}`,
			failed: false,
			input,
		};
	});

const tool: Tool = { declaration: toolDeclaration, execute };

/** The argument value a call must not carry — the veto stage's trigger. */
const FORBIDDEN = "forbidden";

/**
 * The pre-flight hook (spec §5): refuse a call whose parsed arguments carry the
 * forbidden word. Everything else is allowed, and an unparsable argument list
 * is allowed too — refusing there would be a policy this example does not mean.
 */
const vetoStage: Omit<PipelineEntry, "owner"> = {
	id: "example.custom-tool.veto",
	kind: "onToolCall",
	run: (call: { readonly args: string }, _meta: unknown) =>
		Effect.sync(() => {
			const args = call.args.includes(FORBIDDEN);
			return args ? { allow: false } : { allow: true };
		}),
};

export default {
	setup(host: Host) {
		host.tools.register(tool);
		// `pipeline` is the bare registry; `id`, `kind` and `run` on a typed
		// variable are what a plugin passes (see the guide's typing note).
		host.pipeline.register(vetoStage);

		host.log.info(
			`custom-tool loaded; registered "${TOOL_NAME}" and an onToolCall veto`,
		);
	},
};
