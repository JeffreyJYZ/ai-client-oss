import type { ProviderConfig, Settings } from "@lib/db/types";
import type { TitlerOutcome } from "@lib/titlerStatus";

/**
 * The Titler settings section's **pure** half: the resolved model, the settings
 * and the last attempt in, the picker's options and the one-line hint out.
 *
 * The three states are the spec's "Honest UI" split, and each names its remedy:
 *
 * - **resolved** — which model, on which provider, and that the conversation's
 *   first message reaches *that* provider (which may differ from the chat's);
 * - **unresolved** — no request is made at all, so the remedy is the model
 *   picker's own source: an explicit choice, or **Fetch models** on a provider
 *   whose cached list is empty (an empty list carries no free id, by the
 *   rule's own design — `lib/titler.ts` reads the free id out of that list);
 * - **failed** — a model resolved and the last attempt still failed (`dead id,
 *   401, a refused preflight`), read from `lib/titlerStatus.ts`. That record is
 *   the only place this is knowable: the title alone looks exactly like a
 *   titler with nothing to say.
 *
 * Every state also carries the spec's second sentence, that a rename is never
 * overwritten, because it is the one guarantee a user cannot see from the
 * sidebar. Kept out of the component so each state is a value in and a value
 * out, and the repo's tests (no React renderer harness) can drive all three.
 */

/** One selectable model: a provider config and one id from its cached list. */
export interface TitlerOption {
	readonly providerId: string;
	readonly model: string;
	/** What the `<select>` shows: the provider's own label, then the id. */
	readonly label: string;
	/**
	 * True when this option is the **saved override** rather than a cached id —
	 * the model was chosen earlier and the provider's list no longer carries it,
	 * so it is shown anyway (a `<select>` whose value matches no option renders
	 * blank and looks like the choice was lost).
	 */
	readonly saved: boolean;
}

export type TitlerHintState = "resolved" | "unresolved" | "failed";

export interface TitlerRows {
	readonly state: TitlerHintState;
	/** The one line the section shows. */
	readonly hint: string;
	/** Every cached model of every provider, plus the saved override if any. */
	readonly options: readonly TitlerOption[];
	/** The saved override, or `undefined` for "Automatic (free)". */
	readonly selection: TitlerModelChoice | undefined;
	/** The `<select>`'s value: the selection's key, or {@link AUTOMATIC_KEY}. */
	readonly selectionKey: string;
}

/** One provider + one model id: `Settings.titler`'s two fields. */
export interface TitlerModelChoice {
	readonly providerId: string;
	readonly model: string;
}

/**
 * The `<select>`'s value for "Automatic (free)" — both fields unset, so the
 * deterministic rule decides. An empty string is the DOM's natural "no choice"
 * and cannot collide with a real key ({@link titlerOptionKey} always names a
 * non-empty provider and model).
 */
export const AUTOMATIC_KEY = "";

/** The separator inside a `<select>` value. Neither id may contain it. */
const KEY_SEPARATOR = "\u0000";

/** The stable `<select>` value for one provider+model pair. */
export const titlerOptionKey = (choice: TitlerModelChoice): string =>
	`${choice.providerId}${KEY_SEPARATOR}${choice.model}`;

/** A saved override counts only when both fields are present and non-blank. */
const savedChoice = (
	selection: Settings["titler"],
): TitlerModelChoice | undefined => {
	if (selection === undefined) return undefined;
	const providerId = selection.providerId?.trim() ?? "";
	const model = selection.model?.trim() ?? "";
	if (providerId === "" || model === "") return undefined;
	return { providerId, model };
};

/** The provider's own label, falling back to its id when it has none. */
const providerLabel = (
	providers: readonly ProviderConfig[],
	providerId: string,
): string => {
	const config = providers.find((candidate) => candidate.id === providerId);
	const label = config?.label.trim() ?? "";
	return label === "" ? providerId : label;
};

/** Every cached model of every provider, in settings order. */
const optionsOf = (
	providers: readonly ProviderConfig[],
	selection: TitlerModelChoice | undefined,
): readonly TitlerOption[] => {
	const options = providers.flatMap((provider) =>
		provider.models.map((model) => ({
			providerId: provider.id,
			model,
			label: `${providerLabel(providers, provider.id)} · ${model}`,
			saved: false,
		})),
	);
	if (
		selection === undefined ||
		options.some(
			(option) =>
				option.providerId === selection.providerId &&
				option.model === selection.model,
		)
	) {
		return options;
	}
	// The saved choice that is no longer cached, shown so it is not lost.
	return [
		{
			providerId: selection.providerId,
			model: selection.model,
			label: `${providerLabel(providers, selection.providerId)} · ${selection.model} (not in the cached list)`,
			saved: true,
		},
		...options,
	];
};

/** The titler generally, for a state with no attempt to explain. */
const RENAME_CLAUSE = "A rename is never overwritten.";

/** State 1: a model resolved, and the last attempt (if any) did not fail. */
const resolvedHint = (
	choice: TitlerModelChoice,
	providers: readonly ProviderConfig[],
): string =>
	`Titles new chats with “${choice.model}” on ${providerLabel(providers, choice.providerId)}. ` +
	`The first message is sent to that provider, which may be a different one from your chat. ${RENAME_CLAUSE}`;

/** State 3: resolved, and the last attempt failed — with its own reason. */
const failedHint = (
	choice: TitlerModelChoice,
	providers: readonly ProviderConfig[],
	reason: string,
): string =>
	`Titles new chats with “${choice.model}” on ${providerLabel(providers, choice.providerId)}, ` +
	`but the last attempt failed: ${reason} Pick another model below, or press Fetch models. ${RENAME_CLAUSE}`;

/** State 2: nothing resolves, so no request is made and the row says why not. */
const unresolvedHint = (): string =>
	"No model titles new chats yet. Choose one below, or press Fetch models on a provider in Providers — " +
	`an empty cached model list carries no free model to fall back to. ${RENAME_CLAUSE}`;

/**
 * The section's whole view-model. `resolved` is the caller's `resolveTitlerModel`
 * answer (so this module needs no `isDesktop` and no settings store), `status`
 * the last attempt, or `undefined` when none has run.
 */
export const titlerRows = (input: {
	readonly resolved: TitlerModelChoice | undefined;
	readonly providers: readonly ProviderConfig[];
	readonly selection: Settings["titler"];
	readonly status: TitlerOutcome | undefined;
}): TitlerRows => {
	const selection = savedChoice(input.selection);
	const options = optionsOf(input.providers, selection);
	const selectionKey =
		selection === undefined ? AUTOMATIC_KEY : titlerOptionKey(selection);

	if (input.resolved === undefined) {
		return {
			state: "unresolved",
			hint: unresolvedHint(),
			options,
			selection,
			selectionKey,
		};
	}
	// The record is one slot with no conversation id or timestamp, so a failure
	// from a *different* model is not evidence about the one that resolves now.
	// Show it only when the attempt that failed used exactly this model;
	// otherwise the row is the plain "resolved" state.
	if (
		input.status !== undefined &&
		!input.status.ok &&
		input.status.model === input.resolved.model
	) {
		return {
			state: "failed",
			hint: failedHint(input.resolved, input.providers, input.status.reason),
			options,
			selection,
			selectionKey,
		};
	}
	return {
		state: "resolved",
		hint: resolvedHint(input.resolved, input.providers),
		options,
		selection,
		selectionKey,
	};
};

/**
 * What the picker persists: the chosen provider+model, or **both fields unset**
 * for "Automatic (free)" — never an empty-string pair, which the rule would
 * treat as an override that resolves to nothing.
 */
export const titlerSelectionPatch = (
	choice: TitlerModelChoice | undefined,
): Pick<Settings, "titler"> => ({
	titler:
		choice === undefined
			? undefined
			: { providerId: choice.providerId, model: choice.model },
});
