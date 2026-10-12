import type { Host } from "@lib/plugins/host";
import Composer, {
	AttachmentChip,
	ComposerAttach,
	ComposerSend,
	ComposerStop,
	ComposerTextarea,
} from "@/ui/Composer";

/**
 * The composer area's built-in contributions (spec §4): the composer itself as
 * the `composer.root` region's default, and the pieces of its toolbar and
 * actions rows. Registered through the `Host` — the same public API a plugin
 * uses — so every one is owned by the built-in plugin and disposed with it.
 *
 * The registration order is the render order within a region: `order` is the
 * first sort key, so the toolbar is the file input and attach button, then the
 * textarea, exactly as the pre-task composer rendered them.
 */
export const registerComposerBuiltins = (host: Host): void => {
	// The composer itself, under the `ui.composer` component id: `useComponent`
	// and an override resolve it there, and T6's layout renders it by taking
	// the `composer.root` slot.
	host.ui.register({
		id: "ui.composer",
		slot: "composer.root",
		component: Composer,
	});

	// The overridable attachment chip. `<Composer>` resolves it per chip through
	// `useComponent("ui.attachment-chip")`; when the toolbar slot renders the
	// entry directly it carries no attachment and draws nothing (see the
	// component).
	host.ui.register({
		id: "ui.attachment-chip",
		slot: "composer.toolbar",
		component: AttachmentChip,
	});

	host.ui.register({
		id: "composer.toolbar.attach",
		slot: "composer.toolbar",
		order: 1,
		component: ComposerAttach,
	});
	host.ui.register({
		id: "composer.toolbar.textarea",
		slot: "composer.toolbar",
		order: 2,
		component: ComposerTextarea,
	});

	host.ui.register({
		id: "composer.actions.stop",
		slot: "composer.actions",
		order: 1,
		component: ComposerStop,
	});
	host.ui.register({
		id: "composer.actions.send",
		slot: "composer.actions",
		order: 2,
		component: ComposerSend,
	});
};
