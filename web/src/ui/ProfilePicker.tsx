import { useState } from "react";
import { applyProfile } from "@/state/profiles";
import { useSettings } from "@/state/settings";

const CONTROL =
	"max-w-[12rem] truncate rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-500 focus:outline-none";

const NONE = "";

/**
 * Chat-header profile picker. Choosing a profile applies it (provider + model +
 * the active conversation's system prompt) and keeps the choice shown; the `—`
 * option is a no-op reset. When the chosen profile is deleted the select falls
 * back to `—` on its own.
 */
export default function ProfilePicker() {
	const { profiles } = useSettings();
	const [selectedId, setSelectedId] = useState<string>(NONE);

	const value = profiles.some((profile) => profile.id === selectedId)
		? selectedId
		: NONE;

	const onChange = (id: string): void => {
		setSelectedId(id);
		const profile = profiles.find((candidate) => candidate.id === id);
		if (profile !== undefined) applyProfile(profile);
	};

	return (
		<select
			aria-label="Profile"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			disabled={profiles.length === 0}
			className={CONTROL}
		>
			<option value={NONE}>—</option>
			{profiles.map((profile) => (
				<option key={profile.id} value={profile.id}>
					{profile.name.trim() !== "" ? profile.name : "Untitled profile"}
				</option>
			))}
		</select>
	);
}
