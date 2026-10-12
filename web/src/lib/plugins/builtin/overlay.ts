import type { Host } from "@lib/plugins/host";
import Modal from "@/ui/slots/Modal";
import Toasts from "@/ui/slots/Toasts";

/**
 * The overlay region's built-in contributions (spec §4/§5): the toast stack and
 * the single modal surface, both into `overlay.root` — the region Task 13
 * renders in `DefaultLayout`. **Filled by Task 15**; `builtin/index.ts` already
 * called this seam, so the notification components mount without editing the
 * shared hub.
 *
 * `order` is below the command palette's 100, so an open palette stays on top
 * of a toast rather than the other way round. Neither component adds an element
 * while idle — each renders `null` with nothing queued — so the Phase-1 "the
 * overlay contributes nothing until something opens" property holds.
 */
export const registerOverlayBuiltins = (host: Host): void => {
	host.ui.register({
		id: "overlay.toasts",
		slot: "overlay.root",
		component: Toasts,
		order: 10,
	});
	host.ui.register({
		id: "overlay.modal",
		slot: "overlay.root",
		component: Modal,
		order: 20,
	});
};
