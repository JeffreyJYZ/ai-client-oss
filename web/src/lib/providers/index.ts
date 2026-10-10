import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";

export const providers = { anthropic, responses, chatcompletions } as const;
export type ProtocolName = keyof typeof providers;
export const protocolNames = Object.keys(providers) as ProtocolName[];
