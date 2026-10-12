import { describe, expect, test } from "bun:test";
import { registerTranscriptBuiltins } from "@lib/plugins/builtin/transcript";
import type { Contribution, Disposable, Host } from "@lib/plugins/host";
import type { SlotId } from "@lib/plugins/ids";

/**
 * The transcript registrar's interface: which region ids and renderer ids it
 * puts into the `ui` registry. The browser proof covers the rendered DOM; this
 * pins the registration contract so an edit cannot silently drop a region or a
 * renderer override (a dropped `ui.message`, say, would blank every message
 * with no test failing). The registrar only calls `host.ui.register`, so a
 * recording fake is enough — no project module is mocked (R13).
 */

type Registered = Omit<Contribution, "owner">;

const record = (): readonly Registered[] => {
	const entries: Registered[] = [];
	const host = {
		ui: {
			register: (entry: Registered): Disposable => {
				entries.push(entry);
				return { dispose: () => {} };
			},
		},
	} as unknown as Host;
	registerTranscriptBuiltins(host);
	return entries;
};

describe("registerTranscriptBuiltins", () => {
	test("registers every transcript region and renderer id", () => {
		const ids = record().map((entry) => entry.id);
		expect(new Set(ids)).toEqual(
			new Set([
				"chat.pane",
				"chat.messages",
				"chat.empty",
				"chat.stream-status",
				"ui.message",
				"ui.markdown",
				"ui.marker",
				"ui.reasoning",
			]),
		);
	});

	test("each region entry targets its own slot; the renderers carry the message region", () => {
		const byId = new Map(record().map((entry) => [entry.id, entry.slot]));
		const regions = [
			"chat.pane",
			"chat.messages",
			"chat.empty",
			"chat.stream-status",
		] as const;
		for (const id of regions) {
			expect(byId.get(id)).toBe(id);
		}
		// The renderer overrides belong to the message region and are consumed
		// through `useComponent`, so they share one slot (see the file header).
		for (const id of [
			"ui.message",
			"ui.markdown",
			"ui.marker",
			"ui.reasoning",
		] as const) {
			expect(byId.get(id)).toBe("chat.message" satisfies SlotId);
		}
	});

	test("renders nothing extra: chat.message.actions has no built-in", () => {
		expect(
			record().some((entry) => entry.slot === "chat.message.actions"),
		).toBe(false);
	});
});
