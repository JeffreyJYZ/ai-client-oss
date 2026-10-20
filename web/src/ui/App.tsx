import "@/App.css";
import { useOverlay } from "@lib/plugins/notify";
import { useEffect } from "react";
import { checkForReleaseNotes } from "@/state/releaseNotes";
import { useSettingsHydrated } from "@/state/settings";
import { MinimalHost } from "@/ui/MinimalHost";
import ReleaseNotesDialog from "@/ui/ReleaseNotesDialog";
import Slot from "@/ui/slots/Slot";

/**
 * The app's composition root — the container (the locked `app.substrate`),
 * which names the shell's own region and nothing else (spec §4). The tree that
 * used to live here is `ui/slots/DefaultLayout.tsx`, registered as the default
 * contribution to `ui.root.layout`. `Slot` renders **every** contribution, so a
 * plugin that also contributes there renders *alongside* this one rather than
 * replacing it — taking over the window means covering it visually, the way
 * `web/plugins/zen-view/main.tsx` does.
 *
 * {@link MinimalHost} is the container's last resort, and it is here rather
 * than in a registrar because this component *is* the container: the locked
 * area's job is to guarantee a way back to the manager, and an empty
 * `ui.root.layout` is exactly the state in which that guarantee must be
 * rendered instead of assumed (spec "The locked core"). It renders nothing
 * while any layout contribution is visible, so with no plugins the DOM is the
 * slot's own and nothing else.
 *
 * The app's own release notes mount here too, at the container level, so they
 * render on every platform and in every built-in configuration (shell off,
 * overlays off) rather than riding a toggleable area. A queued plugin dialog
 * takes the screen first; the notes appear once that queue is empty. The
 * once-per-version check waits for the settings to hydrate, because the
 * dismissed version is only then the stored one.
 */
export default function App() {
	const { modals } = useOverlay();
	const hydrated = useSettingsHydrated();

	useEffect(() => {
		if (!hydrated) return;
		checkForReleaseNotes();
	}, [hydrated]);

	return (
		<>
			<Slot id="ui.root.layout" />
			<MinimalHost />
			{modals.length === 0 ? <ReleaseNotesDialog /> : null}
		</>
	);
}
