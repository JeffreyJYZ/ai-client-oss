import type { Host } from "@lib/plugins/host";
import { ConversationList, NewChatButton } from "@/ui/ConversationList";
import {
	BackupSection,
	ProfileEditor,
	ProfilesSection,
	ProviderEditor,
	ProviderSection,
	SettingsNotices,
	UpdatesSection,
	WebSearchSection,
} from "@/ui/Settings";

/**
 * The settings and sidebar area's built-in contributions (spec §4/§12): its
 * eight sections (`settings.sections`) and the conversation sidebar
 * (`app.sidebar` + `app.sidebar.actions`). Registered through the `Host` — the
 * same public API a plugin uses — so each region can be reordered, hidden or
 * replaced.
 *
 * Every `order` is explicit and ascending, holding today's top-to-bottom render
 * order, because resolution falls back to registration order: a later task (or
 * a plugin) must be able to slot itself between two built-ins, not only after
 * all of them. `settings.nav` carries no built-in — it is a seam for plugins.
 *
 * The eight `settings.sections` entries, in render order: the page's warning
 * banners, Providers, the provider editor, Profiles, the profile editor, Web
 * search, Backup, Updates. Two sections that render into that same list do
 * **not** live here, and neither does the surface itself — all three by design
 * rather than oversight:
 *
 * - Memory rides `app.memory` (`builtin/memory.ts`), so the feature's area
 *   toggle takes the section, the five tools, the memory prompt sent with each
 *   request while notes are live, the reply-text strip and the recording of
 *   notes the model writes;
 * - the Plugins section rides the locked `app.builtins` (`areas.ts`
 *   `registerManager`);
 * - the Settings **surface** (`settings.root`) rides the locked `app.substrate`
 *   (`areas.ts` `registerSubstrate`), because every section renders into it —
 *   the manager's included — so the surface is part of the way back, not
 *   something turning this area off may take away.
 *
 * The last two are the same move one level apart: the route back is not owned
 * by the area it returns from.
 */
export const registerSettingsBuiltins = (host: Host): void => {
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
