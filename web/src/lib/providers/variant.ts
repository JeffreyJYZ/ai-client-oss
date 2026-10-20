/**
 * The generation parameters a **variant** carries, and the wire fields each
 * protocol sends them in.
 *
 * A variant is the app's own bundle of request parameters (temperature, top-p,
 * a token cap, a reasoning effort) — the request-side twin of a provider
 * profile, which bundles the endpoint and the model instead. The stored shape
 * lives in `lib/db/types.ts` (`variantSchema`); this module is the *wire* side
 * of it, and the stored schema is typed against {@link VariantParams} so the
 * two cannot drift: a parameter added to one and forgotten in the other fails
 * the build.
 *
 * Every parameter is optional, and a parameter the variant does not set is
 * **not sent**: the endpoint's own default stands. Nothing here guesses a
 * value, and nothing here invents a field a protocol does not have.
 */

/** The reasoning efforts a variant may pin, in the order the editor offers them. */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * A variant's parameters, in the stored names: the wire mapping renames them
 * (`topP` → `top_p`), and the id and the name are not parameters at all — the
 * wire never carries them.
 */
export interface VariantParams {
	readonly temperature?: number;
	readonly topP?: number;
	readonly maxTokens?: number;
	readonly reasoningEffort?: ReasoningEffort;
}

/**
 * The wire field each parameter goes in, per protocol. The table is the single
 * source of both the field names and the result type, so a parameter added to
 * {@link VariantParams} and forgotten in a protocol's table is a compile error
 * rather than a parameter that silently stops being sent.
 */
type WireTable = Readonly<Record<string, string>>;

/**
 * The wire fields a table produces: each parameter's value under the field
 * name the table gives it.
 */
type WireFields<T extends WireTable> = {
	readonly [P in Extract<keyof VariantParams, keyof T> as T[P]]?: NonNullable<
		VariantParams[P]
	>;
};

/**
 * Whether the body a provider is building is this turn's **own** body, replayed
 * by the tool loop, rather than the turn's fresh composition.
 *
 * A turn composes one body and hands it back to the provider for every round
 * with `skipUserMessage` set: the body already carries the turn's user
 * message, so the builder appends nothing new. The same is true of the
 * variant's parameters — they were written when the body was composed — so a
 * replayed body is left alone. That is what keeps the replay the **identity**
 * (the body a round sends is the body the turn stored) and what keeps a
 * `transformBody` stage's own value for a parameter field alive across the
 * rounds: the stage runs once per turn, and its rewrite is what the turn
 * sends.
 */
export const isTurnReplay = (ctx: {
	readonly skipUserMessage?: boolean;
}): boolean => ctx.skipUserMessage === true;

/**
 * The chat/completions wire field each parameter goes in. This protocol sends
 * every parameter, so its table names them all.
 */
const CHAT_COMPLETIONS_FIELDS = {
	temperature: "temperature",
	topP: "top_p",
	maxTokens: "max_tokens",
	reasoningEffort: "reasoning_effort",
} as const satisfies Record<keyof VariantParams, string>;

/**
 * The responses wire field each parameter goes in. The effort is nested under
 * `reasoning` there, so it is handled apart from the flat table — and the
 * table still names every *other* parameter, so a new one cannot be added
 * without a decision here.
 */
const RESPONSES_FIELDS = {
	temperature: "temperature",
	topP: "top_p",
	maxTokens: "max_output_tokens",
} as const satisfies Record<
	Exclude<keyof VariantParams, "reasoningEffort">,
	string
>;

/**
 * The Anthropic messages wire field each parameter goes in. Anthropic's API has
 * no reasoning-effort field, so the effort is simply not sent there — the one
 * parameter this protocol leaves out, named rather than silently dropped.
 */
const ANTHROPIC_FIELDS = {
	temperature: "temperature",
	topP: "top_p",
	maxTokens: "max_tokens",
} as const satisfies Record<
	Exclude<keyof VariantParams, "reasoningEffort">,
	string
>;

/** The chat/completions wire fields: the OpenAI-shaped names. */
export type ChatCompletionsVariant = WireFields<typeof CHAT_COMPLETIONS_FIELDS>;

/** The responses wire fields: OpenAI's Responses names, with a nested effort. */
export type ResponsesVariant = WireFields<typeof RESPONSES_FIELDS> & {
	readonly reasoning?: { readonly effort: ReasoningEffort };
};

/** The Anthropic messages wire fields: no reasoning-effort field exists there. */
export type AnthropicVariant = WireFields<typeof ANTHROPIC_FIELDS>;

/** The fields a table writes, with the values the variant set. */
const fieldsFor = <T extends WireTable>(
	params: VariantParams | undefined,
	table: T,
): WireFields<T> => {
	const fields: Record<string, unknown> = {};
	for (const [param, field] of Object.entries(table)) {
		const value = params?.[param as keyof VariantParams];
		if (value !== undefined) fields[field] = value;
	}
	return fields as WireFields<T>;
};

/**
 * The chat/completions fields for a variant: only the parameters it sets, so
 * an unset one is absent from the body rather than sent as a guess.
 */
export const chatCompletionsVariant = (
	params?: VariantParams,
): ChatCompletionsVariant => fieldsFor(params, CHAT_COMPLETIONS_FIELDS);

/**
 * The responses fields for a variant: OpenAI's Responses names
 * (`max_output_tokens` for the token cap) and the reasoning effort nested under
 * `reasoning`.
 */
export const responsesVariant = (params?: VariantParams): ResponsesVariant => {
	const fields = fieldsFor(params, RESPONSES_FIELDS);
	return {
		...fields,
		...(params?.reasoningEffort === undefined
			? {}
			: { reasoning: { effort: params.reasoningEffort } }),
	};
};

/**
 * The Anthropic messages fields for a variant. Anthropic's API has no
 * reasoning-effort field, so an effort is simply not sent there; the token cap
 * is the one parameter whose default the module owns (the API requires it), and
 * a variant's cap overrides that default.
 */
export const anthropicVariant = (params?: VariantParams): AnthropicVariant =>
	fieldsFor(params, ANTHROPIC_FIELDS);
