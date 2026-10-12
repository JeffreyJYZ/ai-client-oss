import { beforeEach, describe, expect, test } from "bun:test";
import {
	getUIState,
	setPalette,
	setView,
	subscribe,
	type UIView,
	uiStateSchema,
} from "@/state/ui";

/**
 * The shell's view store. No DOM: the store is a plain module variable plus a
 * listener set, so it is driven directly. The hook wrapper
 * (`useSyncExternalStore`) and the effect of a view change on the rendered
 * shell are the browser proof's job — a DOM-less runner cannot mount React.
 */

const reset = (): void => {
	setView("chat");
	setPalette(false);
};

beforeEach(reset);

describe("state/ui", () => {
	test("starts on the chat view with no palette", () => {
		// A fresh module always boots here; this also pins the shape the shell
		// reads, so adding a field cannot silently change the initial view.
		expect(getUIState()).toEqual({ view: "chat", palette: false });
		expect(uiStateSchema.safeParse(getUIState()).success).toBe(true);
	});

	test("setView switches the view and notifies each listener exactly once", () => {
		const seen: string[] = [];
		const unsubscribe = subscribe(() => seen.push(getUIState().view));

		setView("settings");
		expect(getUIState().view).toBe("settings");
		expect(seen).toEqual(["settings"]);

		unsubscribe();
		setView("chat");
		expect(getUIState().view).toBe("chat");
		// Unsubscribed: no further notifications.
		expect(seen).toEqual(["settings"]);
	});

	test("setPalette writes the flag without disturbing the view", () => {
		setView("settings");
		setPalette(true);
		expect(getUIState()).toEqual({ view: "settings", palette: true });
	});

	test("an invalid view is dropped, not stored", () => {
		// A plugin is untyped JavaScript at this boundary; the schema is what
		// stops an unknown view from reaching the shell.
		setView("nope" as UIView);
		expect(getUIState().view).toBe("chat");
	});

	test("subscribe returns an idempotent unsubscribe", () => {
		const unsubscribe = subscribe(() => {});
		unsubscribe();
		expect(() => unsubscribe()).not.toThrow();
	});
});
