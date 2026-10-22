import { openExternal } from "@lib/external";
import type { ReactNode } from "react";

/**
 * A link out of the app — the same thing on both builds, through
 * {@link openExternal}: the browser opens a tab, the desktop shell hands the
 * URL to the OS because a webview cannot (see `open_external` in
 * `src-tauri/src/lib.rs`).
 *
 * `href` stays on the element so the destination is still visible to the DOM
 * (hover, copy, a middle-click on the web); the click is intercepted for both
 * builds so the desktop cannot try a navigation it will silently drop.
 */
export default function ExternalLink({
	href,
	className,
	title,
	children,
}: {
	readonly href: string;
	readonly className?: string;
	readonly title?: string;
	readonly children: ReactNode;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			title={title}
			className={className}
			onClick={(event) => {
				event.preventDefault();
				openExternal(href);
			}}
		>
			{children}
		</a>
	);
}
