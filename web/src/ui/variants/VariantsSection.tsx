import { useState } from "react";
import {
	addVariant,
	removeVariant,
	selectVariant,
	updateVariant,
	useSettings,
} from "@/state/settings";
import ConfirmButton from "@/ui/ConfirmButton";
import {
	BUTTON,
	INPUT,
	LABEL,
	SECTION,
	SECTION_HEADING,
	SECTION_SUMMARY,
	Section,
} from "@/ui/kit";
import {
	EFFORT_OPTIONS,
	editEffort,
	editNumber,
	type FieldEdit,
	VARIANT_NUMBER_FIELDS,
	variantLabel,
} from "@/ui/variants/variantFields";

/**
 * The Variants settings section: the saved generation-parameter bundles and
 * which one is active.
 *
 * A variant is the request-side twin of a profile — a profile bundles the
 * endpoint and the model, a variant bundles the parameters sent with every
 * request. The active one rides the request context (`state/chat.ts` reads it
 * where the turn is built) and each protocol maps it onto its own field names
 * (`lib/providers/variant.ts`).
 *
 * **The switch is the active pointer, not a toggle.** No active variant means
 * the request carries no parameter at all, so the endpoint's own defaults
 * stand; picking one adds exactly the parameters that variant sets. It is
 * stored state, the same kind as the active provider: the section *edits* it,
 * and the effect stays when the section is hidden.
 *
 * **Every rule about what a parameter may be lives in the schema**
 * (`variantSchema` in `lib/db/types.ts`), not here: this component parses what
 * the user typed and asks the schema whether the result is a legal variant, so
 * the editor and the stored shape can never disagree about the ranges. A
 * refused value is shown with the schema's own message and is not written.
 */
export function VariantsSection() {
	const settings = useSettings();
	const variants = settings.variants;
	/**
	 * The variant the pointer names, or `undefined` when it names none (or
	 * names one that is gone): the same tolerance the request path has.
	 */
	const active = variants.find(
		(variant) => variant.id === settings.activeVariantId,
	);
	/**
	 * The text the user is typing in a numeric field, keyed by
	 * `variantId:field`. Kept while the field has focus so a half-typed value
	 * (`1.`, `0`) is not rewritten under the cursor; the stored value is the
	 * parsed one, and the field falls back to it on blur.
	 */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	/** The schema's complaint per field, keyed the same way. */
	const [errors, setErrors] = useState<Record<string, string>>({});

	const key = (id: string, field: string): string => `${id}:${field}`;

	const applyEdit = (id: string, field: string, edit: FieldEdit): void => {
		if (!edit.ok) {
			setErrors((current) => ({ ...current, [key(id, field)]: edit.message }));
			return;
		}
		setErrors((current) => {
			const next = { ...current };
			delete next[key(id, field)];
			return next;
		});
		updateVariant(id, edit.patch);
	};

	const clearField = (id: string, field: string): void => {
		setDrafts((current) => {
			const next = { ...current };
			delete next[key(id, field)];
			return next;
		});
		setErrors((current) => {
			const next = { ...current };
			delete next[key(id, field)];
			return next;
		});
	};

	return (
		<Section
			className={SECTION}
			summaryClassName={SECTION_SUMMARY}
			heading={
				<>
					<h3 className={SECTION_HEADING}>Variants</h3>
					<button type="button" onClick={() => addVariant()} className={BUTTON}>
						Add variant
					</button>
				</>
			}
		>
			<p className="text-xs text-neutral-500">
				A variant bundles the parameters every request carries — temperature,
				top-p, a token cap, a reasoning effort. The active one is applied to
				outgoing requests; with none active no parameter is sent and the
				endpoint&apos;s own defaults stand.
			</p>

			{variants.length === 0 ? (
				<p className="text-sm text-neutral-500">
					No variants yet — add one to bundle request parameters.
				</p>
			) : (
				<>
					<label className={LABEL}>
						Active variant
						<select
							value={active === undefined ? "" : active.id}
							onChange={(event) => selectVariant(event.target.value)}
							className={INPUT}
						>
							<option value="">— none —</option>
							{variants.map((variant) => (
								<option key={variant.id} value={variant.id}>
									{variantLabel(variant)}
								</option>
							))}
						</select>
					</label>

					<ul className="flex flex-col gap-3">
						{variants.map((variant) => (
							<li
								key={variant.id}
								className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-3"
							>
								<div className="flex items-center gap-2">
									<input
										type="text"
										value={variant.name}
										onChange={(event) =>
											updateVariant(variant.id, { name: event.target.value })
										}
										placeholder="Untitled variant"
										aria-label="Variant name"
										className={`${INPUT} flex-1`}
									/>
									<ConfirmButton
										label="Remove"
										confirmLabel="Confirm?"
										onConfirm={() => removeVariant(variant.id)}
										className={BUTTON}
									/>
								</div>

								<div className="flex flex-wrap gap-3">
									{VARIANT_NUMBER_FIELDS.map((field) => {
										const draft = drafts[key(variant.id, field)];
										const stored = variant[field];
										const error = errors[key(variant.id, field)];
										return (
											<label key={field} className={LABEL}>
												{field === "topP"
													? "Top P"
													: field === "maxTokens"
														? "Max tokens"
														: "Temperature"}
												<input
													type="text"
													inputMode="decimal"
													value={
														draft ??
														(stored === undefined ? "" : String(stored))
													}
													onChange={(event) => {
														const raw = event.target.value;
														setDrafts((current) => ({
															...current,
															[key(variant.id, field)]: raw,
														}));
														applyEdit(
															variant.id,
															field,
															editNumber(variant, field, raw),
														);
													}}
													onBlur={() => clearField(variant.id, field)}
													aria-invalid={error !== undefined}
													className={INPUT}
												/>
												{error === undefined ? null : (
													<span className="text-red-400">{error}</span>
												)}
											</label>
										);
									})}
									<label className={LABEL}>
										Reasoning effort
										<select
											value={variant.reasoningEffort ?? ""}
											onChange={(event) =>
												applyEdit(
													variant.id,
													"reasoningEffort",
													editEffort(
														variant,
														event.target.value as
															| ""
															| "low"
															| "medium"
															| "high",
													),
												)
											}
											className={INPUT}
										>
											{EFFORT_OPTIONS.map((effort) => (
												<option key={effort} value={effort}>
													{effort === "" ? "—" : effort}
												</option>
											))}
										</select>
									</label>
								</div>
							</li>
						))}
					</ul>
				</>
			)}
		</Section>
	);
}
