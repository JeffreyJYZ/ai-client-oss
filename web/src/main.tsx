import { bootRegistryBridge } from "@lib/plugins/bridge";
import { reconcileBuiltins } from "@lib/plugins/builtin";
import { HostServices } from "@lib/plugins/host";
import { runtime } from "@lib/plugins/runtime";
import { Effect } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/ui/App";

const root = document.getElementById("root");

// biome-ignore lint/plugin/no-throw: root element must exist before mount
if (!root) throw new Error("unable to locate root");

/**
 * The boot.
 *
 * Registration happens through `reconcileBuiltins`, not a single host: each
 * enabled built-in area registers into a `Scope` of its own, so a later toggle
 * closes exactly one area and leaves no trace (spec "Registration, teardown,
 * reconcile"). That call also installs the store subscription, so every toggle
 * or preset reconciles from here on.
 *
 * It is asynchronous because it cannot be built synchronously: `HostLayer`
 * resolves the app version with `runningVersion()`, a Tauri IPC promise on the
 * desktop build. `Effect.runSync` over that throws `AsyncFiberError` before
 * `createRoot`, which is exactly how a sync boot leaves the desktop app blank
 * while web (where the version is a constant) boots fine.
 *
 * The registration runs before the bridge and both run before the first render:
 * the bridge's stream replays the current snapshot to its subscriber (the `ui`
 * registry's `PubSub` keeps one), so the first render already sees every
 * built-in.
 */
// biome-ignore lint/plugin/no-await: the ESM entry must await the runtime before its first render
await runtime.runPromise(
	Effect.gen(function* () {
		const services = yield* HostServices;
		yield* reconcileBuiltins(services);
	}),
);

// Exactly once. The bridge is not idempotent — a second call forks a second
// fiber over the same stream, so every mutation would notify listeners twice
// and two writers would race for the snapshot.
bootRegistryBridge();

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
