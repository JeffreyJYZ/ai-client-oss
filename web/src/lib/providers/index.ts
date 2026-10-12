import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";

/**
 * The three shipping protocol implementations (spec §5). This is a **record of
 * implementations**, not the lookup the app resolves through: that is the
 * registry (`@lib/plugins/providers`), which is the only thing that knows a
 * plugin's protocol exists. `registerProviderBuiltins` seeds it from this map.
 */
export const builtinProviders = {
	anthropic,
	responses,
	chatcompletions,
} as const;

/**
 * A wire protocol name. Widened from `keyof typeof builtinProviders` to
 * `string`: a plugin may register a protocol this build has never heard of
 * (spec §5/§13), so any string is a valid name and whether one resolves is the
 * registry's business, not the type's. Kept as the stored `protocol` field's
 * type (`db/types.ts`), so the schema and the registry agree.
 */
export type ProtocolName = string;
