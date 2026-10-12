import type { Host } from "@lib/plugins/host";
import ProfilePicker from "@/ui/ProfilePicker";
import ProviderPicker from "@/ui/ProviderPicker";
import SystemPrompt from "@/ui/SystemPrompt";
import DefaultLayout, {
	DownloadLink,
	HeaderTitle,
	InstallNote,
	SettingsToggle,
} from "@/ui/slots/DefaultLayout";
import UpdateNotice from "@/ui/UpdateNotice";

/**
 * The shell area's built-in contributions (spec §4/§12): the default root
 * layout, the header, and the notices strips. Registering through the `Host` —
 * the same public API a plugin uses — is what proves the API by the app.
 *
 * Every `order` is explicit and ascending, holding today's left-to-right /
 * top-to-bottom render order, because resolution falls back to registration
 * order and a later task (or a plugin) must be able to slot itself in between
 * two built-ins rather than only after all of them.
 *
 * App.tsx's header row becomes `app.header.actions` with its five children
 * registered here one by one, so a plugin can reorder, hide, or replace any
 * single control; the row's own container stays in the layout, which is why
 * the built-ins do not carry it.
 */
export const registerShellBuiltins = (host: Host): void => {
	// The root layout is itself the default contribution to `ui.root.layout`
	// (spec §4), so a plugin taking over the shell is one more contribution to
	// the same slot, not a special case.
	host.ui.register({
		id: "ui.root.layout",
		slot: "ui.root.layout",
		component: DefaultLayout,
		order: 0,
	});

	host.ui.register({
		id: "shell.header.title",
		slot: "app.header.title",
		component: HeaderTitle,
		order: 10,
	});

	host.ui.register({
		id: "shell.header.system-prompt",
		slot: "app.header.actions",
		component: SystemPrompt,
		order: 10,
	});
	host.ui.register({
		id: "shell.header.profile-picker",
		slot: "app.header.actions",
		component: ProfilePicker,
		order: 20,
	});
	host.ui.register({
		id: "shell.header.provider-picker",
		slot: "app.header.actions",
		component: ProviderPicker,
		order: 30,
	});
	host.ui.register({
		id: "shell.header.download",
		slot: "app.header.actions",
		component: DownloadLink,
		order: 40,
	});
	host.ui.register({
		id: "shell.header.settings-toggle",
		slot: "app.header.actions",
		component: SettingsToggle,
		order: 50,
	});

	host.ui.register({
		id: "shell.notices.install-note",
		slot: "app.notices",
		component: InstallNote,
		order: 10,
	});
	host.ui.register({
		id: "shell.notices.update",
		slot: "app.notices",
		component: UpdateNotice,
		order: 20,
	});
};
