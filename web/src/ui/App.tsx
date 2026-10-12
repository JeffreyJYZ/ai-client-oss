import "@/App.css";
import Slot from "@/ui/slots/Slot";

/**
 * The app's composition root — names the shell's own region and nothing else
 * (spec §4). The tree that used to live here is `ui/slots/DefaultLayout.tsx`,
 * registered as the default contribution to `ui.root.layout`, so a plugin can
 * replace the whole shell by contributing to the same slot.
 */
export default function App() {
	return <Slot id="ui.root.layout" />;
}
