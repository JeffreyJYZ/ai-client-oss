import type { Host } from "@lib/plugins/host";
import { registerProvider } from "@lib/plugins/providers";
import { builtinProviders } from "@lib/providers";

/**
 * The built-in protocols' registrar (spec §5). All three go in through the same
 * `registerProvider` seam a plugin uses, owned by the built-in plugin's `Host`,
 * so `SendMsg` resolves them exactly as it would a plugin's protocol.
 *
 * They register first (this runs at boot, before any plugin loads), which is
 * what makes a plugin's same-name protocol a refused duplicate rather than a
 * silent replacement.
 *
 * The names come from `builtinProviders` — the three implementation modules —
 * rather than being retyped here, so the registry's initial contents and the
 * implementations cannot drift apart.
 *
 * Keep the export name and signature; fill only the body.
 */
export const registerProviderBuiltins = (host: Host): void => {
	for (const [name, provider] of Object.entries(builtinProviders)) {
		registerProvider(host, name, provider);
	}
};
