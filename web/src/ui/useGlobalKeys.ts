import {
	matchKeybinding,
	resolveKeybinding,
	runCommand,
} from "@lib/plugins/commands";
import { runtime } from "@lib/plugins/runtime";
import { Option } from "effect";
import { useEffect } from "react";
import { getUIState, setPalette } from "@/state/ui";

/**
 * The global key handler (spec §5), mounted once by the root layout. It is a
 * **scoped effect**: the listener is attached on mount and removed by the
 * effect's finalizer, so it cannot outlive the layout that owns it — a listener
 * left behind on the document is the leak this shape prevents.
 *
 * Resolution is two steps and both are pure registry reads: `matchKeybinding`
 * turns the event into a canonical binding (or nothing, for a keystroke typed
 * into a text surface), and `resolveKeybinding` maps that to a command id.
 * Nothing matches → the event is untouched, so typing in the composer,
 * `<details>` toggling and browser shortcuts all behave as before.
 */
export const useGlobalKeys = (): void => {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			// While the palette is open it owns the keyboard: Escape closes it
			// and everything else belongs to its search field.
			if (getUIState().palette) {
				if (event.key === "Escape") setPalette(false);
				return;
			}
			const binding = matchKeybinding(event);
			if (Option.isNone(binding)) return;
			const id = runtime.runSync(resolveKeybinding(binding.value));
			if (Option.isNone(id)) return;
			event.preventDefault();
			runtime.runFork(runCommand(id.value));
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);
};
