import type { Host } from "@lib/plugins/sdk";
import { createElement, useState } from "react";

/**
 * hello-world — the smallest useful plugin (spec §2/§4).
 *
 * Three things, one per contract this example exists to prove:
 *
 * - a **slot contribution**: `chat.message.actions` is the region `Message.tsx`
 *   renders under a message, and what is registered here appears there;
 * - the **component kit**: the button is `host.ui.kit.Button` — the app's own
 *   `Button`, on the app's React instance — so it matches a built-in's exactly
 *   without copying a single Tailwind class;
 * - the **lifecycle**: registering returns a `Disposable`, and the handle this
 *   `setup` returns is disposed first on unload — so disabling the plugin in the
 *   Plugins section removes the contribution and clears the marker, with no
 *   reload.
 *
 * The component is a plain React function created with `createElement` (this
 * file is `.ts`, per the plan's file list, so there is no JSX). It arrives
 * through the host's React global — the build preset maps the `react` import
 * onto it — so `useState` is the app's own React instance, not a second copy,
 * and it renders the kit's components without a second component tree.
 *
 * `document` is available: a plugin runs in the page, in-process, with full
 * trust.
 */

/** The attribute this plugin sets while it is loaded; the browser proof reads it. */
const LOADED_MARKER = "data-example-hello-world";

/** The one contributed component. `host` is closed over from `setup`. */
const makeHelloButton = (host: Host) =>
	function HelloButton() {
		const [count, setCount] = useState(0);
		// The kit is a stable object on `host.ui`; destructuring it here is only
		// for readability.
		const { Button } = host.ui.kit;
		return createElement(
			Button,
			{
				onClick: () => {
					const next = count + 1;
					setCount(next);
					host.notify.toast({ text: `hello-world: clicked ${next} time(s)` });
				},
			},
			`👋 hello ${count}`,
		);
	};

export default {
	setup(host: Host) {
		host.log.info(`hello-world loaded against plugin API ${host.version.api}`);

		host.ui.register({
			id: "example.hello-world.message-action",
			slot: "chat.message.actions",
			component: makeHelloButton(host),
		});

		// Proves the event bus reaches a plugin, and that a subscription's
		// disposal is the host's job (the handler stops when this plugin unloads).
		host.on("plugin-loaded", (payload) => {
			host.log.debug(
				`hello-world saw plugin-loaded: ${JSON.stringify(payload)}`,
			);
		});

		document.documentElement.setAttribute(LOADED_MARKER, host.version.api);

		return {
			// The `setup` handle is disposed **first** on unload (spec §2), before
			// the registrations this plugin made are collected.
			dispose: () => {
				document.documentElement.removeAttribute(LOADED_MARKER);
				host.log.info("hello-world unloaded; its marker is cleared");
			},
		};
	},
};
