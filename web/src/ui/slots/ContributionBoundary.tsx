import { PluginFault } from "@lib/plugins/errors";
import { Effect } from "effect";
import { Component, type ReactNode } from "react";

interface ContributionBoundaryProps {
	/** The plugin that registered the contribution being wrapped. */
	readonly owner: string;
	readonly children: ReactNode;
}

interface ContributionBoundaryState {
	readonly failed: boolean;
}

/**
 * A per-contribution React error boundary (spec §4/§9): a contribution that
 * throws while rendering is caught here, logged as a `PluginFault`, and
 * replaced by a one-line notice, so one broken plugin leaves the rest of the
 * slot — and the page — alive. This is a class boundary on purpose: only a
 * class can implement `componentDidCatch`/`getDerivedStateFromError`, and that
 * is a lifecycle method, not a `try` statement (the Grit rules do not apply to
 * it).
 *
 * The notice names its `owner` **without calling it a plugin**: `owner` is a
 * plugin id for a third-party contribution but a built-in **area** id
 * (`app.shell`) for a built-in one, and the boundary is handed only the string,
 * so it cannot tell the two apart — "plugin app.shell failed" was therefore a
 * false claim about half the things it wraps.
 */
export class ContributionBoundary extends Component<
	ContributionBoundaryProps,
	ContributionBoundaryState
> {
	state: ContributionBoundaryState = { failed: false };

	static getDerivedStateFromError(): ContributionBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: unknown): void {
		Effect.runFork(
			Effect.logWarning(
				new PluginFault({
					detail: `contribution render fault: ${String(error)}`,
					pluginId: this.props.owner,
				}),
			),
		);
	}

	render(): ReactNode {
		if (this.state.failed) {
			return (
				<p className="px-3 py-1 text-xs text-red-400">
					{this.props.owner} failed to render
				</p>
			);
		}
		return this.props.children;
	}
}
