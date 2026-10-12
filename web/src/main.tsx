import { bootRegistryBridge } from "@lib/plugins/bridge";
import { registerBuiltins } from "@lib/plugins/builtin";
import { type Host, HostServices, makeHost } from "@lib/plugins/host";
import { runtime } from "@lib/plugins/runtime";
import { Effect, Scope } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/ui/App";

/**
 * The plugin that owns the app's own contributions (spec §3/§12). Built-ins go
 * through the same `Host` API a plugin does, so every one of them is owned and
 * disposed by the same path — this is the id the `ui` registry records on them.
 */
const BUILTIN_PLUGIN_ID = "app.builtin";

/**
 * The `Host` the built-ins register through: built from the subsystem's one
 * runtime, so a built-in lands in the same registry a plugin's would. Its
 * `Scope` is deliberately never closed — built-ins live as long as the app —
 * which is the only thing that differs from the host the loader builds.
 */
const builtinHost = (): Host =>
	runtime.runSync(
		Effect.gen(function* () {
			const services = yield* HostServices;
			const scope = yield* Scope.make();
			return makeHost(services, BUILTIN_PLUGIN_ID, scope);
		}),
	);

const root = document.getElementById("root");

// biome-ignore lint/plugin/no-throw: root element must exist before mount
if (!root) throw new Error("unable to locate root");

// Registration before the bridge, both before the first render: the bridge's
// stream replays the current snapshot to its subscriber (the `ui` registry's
// `PubSub` keeps one), so the first render already sees every built-in.
registerBuiltins(builtinHost());

// Exactly once. The bridge is not idempotent — a second call forks a second
// fiber over the same stream, so every mutation would notify listeners twice
// and two writers would race for the snapshot.
bootRegistryBridge();

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
