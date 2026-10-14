import "@/App.css";
import { MinimalHost } from "@/ui/MinimalHost";
import Slot from "@/ui/slots/Slot";

/**
 * The app's composition root — the container (the locked `app.substrate`),
 * which names the shell's own region and nothing else (spec §4). The tree that
 * used to live here is `ui/slots/DefaultLayout.tsx`, registered as the default
 * contribution to `ui.root.layout`, so a plugin can replace the whole shell by
 * contributing to the same slot.
 *
 * {@link MinimalHost} is the container's last resort, and it is here rather
 * than in a registrar because this component *is* the container: the locked
 * area's job is to guarantee a way back to the manager, and an empty
 * `ui.root.layout` is exactly the state in which that guarantee must be
 * rendered instead of assumed (spec "The locked core"). It renders nothing
 * while any layout contribution is visible, so with no plugins the DOM is the
 * slot's own and nothing else.
 */
export default function App() {
	return (
		<>
			<Slot id="ui.root.layout" />
			<MinimalHost />
		</>
	);
}
