import DOMPurify from "dompurify";
import { Marked } from "marked";
import { type MouseEvent, useMemo } from "react";

// GFM, soft-line breaks, strictly synchronous parsing.
const marked = new Marked({ gfm: true, breaks: true, async: false });

interface MarkdownProps {
	readonly text: string;
}

/**
 * Renders model output as GitHub-flavoured markdown.
 *
 * The text is untrusted model output: `marked` parses it, `DOMPurify`
 * strips every script/handler/attribute it does not allow, and only then
 * does it reach `dangerouslySetInnerHTML`. A `Copy` button is injected
 * into each fenced block afterwards (on the already-sanitized markup).
 */
export default function Markdown({ text }: MarkdownProps) {
	const html = useMemo(() => {
		const clean = DOMPurify.sanitize(marked.parse(text, { async: false }));
		const doc = new DOMParser().parseFromString(clean, "text/html");
		doc.querySelectorAll("pre").forEach((pre) => {
			const button = doc.createElement("button");
			button.type = "button";
			button.setAttribute("data-md-copy", "");
			button.className = "md-copy";
			button.textContent = "Copy";
			pre.appendChild(button);
		});
		return doc.body.innerHTML;
	}, [text]);

	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		const target = event.target;
		const button =
			target instanceof Element ? target.closest("[data-md-copy]") : null;
		if (button === null) {
			return;
		}
		const pre = button.parentElement;
		if (pre === null) {
			return;
		}
		// Copy the pre's code, minus the Copy buttons themselves.
		const clone = pre.cloneNode(true);
		if (!(clone instanceof Element)) {
			return;
		}
		clone.querySelectorAll("[data-md-copy]").forEach((copy) => {
			copy.remove();
		});
		button.textContent = "Copied";
		window.setTimeout(() => {
			button.textContent = "Copy";
		}, 1500);
		void navigator.clipboard
			.writeText(clone.textContent ?? "")
			.catch(() => undefined);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the click is delegated to the injected copy buttons; this div is a passive markdown container
		// biome-ignore lint/a11y/useKeyWithClickEvents: the injected controls are real <button>s, so keyboard activation already reaches this handler via bubbling
		<div
			className="md"
			onClick={onClick}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is model output parsed by marked and sanitized with DOMPurify before it is rendered
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
