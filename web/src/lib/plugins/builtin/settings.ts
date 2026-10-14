import type { Host } from "@lib/plugins/host";
import { ConversationList, NewChatButton } from "@/ui/ConversationList";
import {
	BackupSection,
	MemorySection,
	ProfileEditor,
	ProfilesSection,
	ProviderEditor,
	ProviderSection,
	SettingsNotices,
	SettingsShell,
	UpdatesSection,
	WebSearchSection,
} from "@/ui/Settings";

/**
 * The settings and sidebar area's built-in contributions (spec §4/§12): the
 * Settings page's chrome (`settings.root`), its nine sections
 * (`settings.sections`), and the conversation sidebar (`app.sidebar` +
 * `app.sidebar.actions`). Registered through the `Host` — the same public API a
 * plugin uses — so each region can be reordered, hidden or replaced.
 *
 * Every `order` is explicit and ascending, holding today's top-to-bottom render
 * order, because resolution falls back to registration order: a later task (or
 * a plugin) must be able to slot itself between two built-ins, not only after
 * all of them. `settings.nav` carries no built-in — it is a seam for plugins.
 *
 * The nine `settings.sections` entries, in render order: the page's warning
 * banners, Providers, the provider editor, Profiles, the profile editor, Web
 * search, Memory, Backup, Updates. The tenth, Plugins, does **not** live here:
 * it rides the locked `app.builtins` area (`areas.ts` `registerManager`), so
 * turning this whole area off cannot take away the way back.
 */
export const registerSettingsBuiltins = (host: Host): void => {
	host.ui.register({
		id: "settings.root.shell",
		slot: "settings.root",
		component: SettingsShell,
		order: 10,
	});

	host.ui.register({
		id: "settings.section.notices",
		slot: "settings.sections",
		component: SettingsNotices,
		order: 10,
	});
	host.ui.register({
		id: "settings.section.providers",
		slot: "settings.sections",
		component: ProviderSection,
		order: 20,
	});
	host.ui.register({
		id: "settings.section.provider-editor",
		slot: "settings.sections",
		component: ProviderEditor,
		order: 30,
	});
	host.ui.register({
		id: "settings.section.profiles",
		slot: "settings.sections",
		component: ProfilesSection,
		order: 40,
	});
	host.ui.register({
		id: "settings.section.profile-editor",
		slot: "settings.sections",
		component: ProfileEditor,
		order: 50,
	});
	host.ui.register({
		id: "settings.section.web-search",
		slot: "settings.sections",
		component: WebSearchSection,
		order: 60,
	});
	host.ui.register({
		id: "settings.section.memory",
		slot: "settings.sections",
		component: MemorySection,
		order: 70,
	});
	host.ui.register({
		id: "settings.section.backup",
		slot: "settings.sections",
		component: BackupSection,
		order: 80,
	});
	host.ui.register({
		id: "settings.section.updates",
		slot: "settings.sections",
		component: UpdatesSection,
		order: 90,
	});

	host.ui.register({
		id: "app.sidebar.chats",
		slot: "app.sidebar",
		component: ConversationList,
		order: 10,
	});
	host.ui.register({
		id: "app.sidebar.actions.new-chat",
		slot: "app.sidebar.actions",
		component: NewChatButton,
		order: 10,
	});
};
