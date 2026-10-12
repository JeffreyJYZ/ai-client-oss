import type { SlotId } from "@lib/plugins/ids";
import { ContributionBoundary } from "@/ui/slots/ContributionBoundary";
import { useContribution } from "@/ui/slots/useContribution";

export interface SlotProps {
	readonly id: SlotId;
	/**
	 * Extra values handed to every contribution in the slot as props — for a
	 * slot whose entries need the host component's own state (the composer
	 * passes its draft text and attachments this way).
	 */
	readonly props?: Record<string, unknown>;
}

/**
 * Render one named UI region (spec §4): every contribution registered to `id`,
 * in resolution order, each inside its own {@link ContributionBoundary} so a
 * contribution that throws cannot blank the slot or the page. Renders nothing
 * when the slot has no visible contributions, and adds no wrapper element of
 * its own — with zero plugins enabled the DOM is exactly what the host
 * component rendered before the slot existed.
 */
export default function Slot({ id, props = {} }: SlotProps) {
	const entries = useContribution(id);
	return (
		<>
			{entries.map((entry) => {
				const Contribution = entry.component;
				return (
					<ContributionBoundary key={entry.id} owner={entry.owner}>
						<Contribution {...props} />
					</ContributionBoundary>
				);
			})}
		</>
	);
}
