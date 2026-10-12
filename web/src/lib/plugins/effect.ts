import type { PluginError } from "@lib/plugins/errors";
import { Effect } from "effect";
import type { z } from "zod";

/**
 * The one zod→Effect seam (spec §3): parse `u` with `schema` and fail the
 * Effect through `onError(detail)` instead of throwing. Curried on the
 * schema so a call site builds its decoder once. Effect 4 has no
 * `orElseFail`, so the failure is mapped after `Effect.try` — same
 * shape: a thrown parse error never escapes into a defect.
 */
export const decode =
	<A, I>(schema: z.ZodType<A, I>, onError: (detail: string) => PluginError) =>
	(u: unknown): Effect.Effect<A, PluginError> =>
		Effect.try({
			try: () => schema.parse(u),
			catch: (cause) => String(cause),
		}).pipe(Effect.mapError(onError));
