import { type ReactNode, useEffect, useRef, useState } from "react";

/** Resting styles; callers may replace them via `className`. */
const BASE =
	"rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700";
/** Laid on top of the resting styles while armed. */
const ARMED =
	"border-red-500/60 bg-red-500/10 text-red-300 hover:border-red-500 hover:bg-red-500/20";

/**
 * Inline two-step destructive action. The first click arms the button
 * (showing `confirmLabel`); only a second click on the armed button runs
 * `onConfirm`. Blur, Escape, or pressing anywhere else disarms, so a
 * stray click never destroys anything. Replaces `window.confirm`, which
 * is platform-dependent in the Tauri webview, and needs no modal.
 */
export default function ConfirmButton({
	label,
	confirmLabel,
	onConfirm,
	className,
	ariaLabel,
}: {
	label: ReactNode;
	confirmLabel: ReactNode;
	onConfirm: () => void;
	className?: string;
	ariaLabel?: string;
}) {
	const [armed, setArmed] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);

	// Click-away: a press outside the button disarms before the click
	// lands, so it can never reach `onConfirm`.
	useEffect(() => {
		if (!armed) return;
		const disarmOutside = (event: MouseEvent): void => {
			if (!ref.current?.contains(event.target as Node)) setArmed(false);
		};
		document.addEventListener("pointerdown", disarmOutside);
		return () => document.removeEventListener("pointerdown", disarmOutside);
	}, [armed]);

	return (
		<button
			ref={ref}
			type="button"
			aria-label={ariaLabel}
			aria-live="polite"
			onClick={() => {
				if (armed) {
					setArmed(false);
					onConfirm();
				} else {
					setArmed(true);
				}
			}}
			onBlur={() => setArmed(false)}
			onKeyDown={(event) => {
				if (event.key === "Escape") setArmed(false);
			}}
			className={`${className ?? BASE}${armed ? ` ${ARMED}` : ""}`}
		>
			{armed ? confirmLabel : label}
		</button>
	);
}
