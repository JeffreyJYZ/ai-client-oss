import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerCommandBuiltins } from "@lib/plugins/builtin/commands";
import { runCommand } from "@lib/plugins/commands";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { clearOverlay, getOverlaySnapshot } from "@lib/plugins/notify";
import { Effect, Scope } from "effect";

/**
 * The built-in commands' side effects, asserted against the real registries.
 * The subject here is the one command whose failure a user can only see if the
 * command itself reports it: `app.backup.export`. The palette's rendering and
 * key handling are the browser proof's job; this checks that a *failed* export
 * reaches the notification surface and that a successful one does not.
 */

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const host = (s: HostServicesShape): ReturnType<typeof makeHost> =>
	makeHost(s, "app.builtin", Effect.runSync(Scope.make()));

const runExport = (s: HostServicesShape): Promise<void> => {
	registerCommandBuiltins(host(s));
	return Effect.runPromise(
		Effect.provideService(runCommand("app.backup.export"), HostServices, s),
	);
};

/**
 * A stand-in for the browser globals the export path touches. This runner has
 * neither `document` nor IndexedDB (verified), so the download needs a fake
 * anchor and the store read needs a fake connection — the same shape of double
 * `installStorage` provides for `localStorage`. `requestsFail` is the single
 * variable between the two cases: it flips every object-store request between a
 * typed failure and a success, which is exactly what separates a silent export
 * from a successful one.
 */
let requestsFail = false;

/** The `download` filename of every anchor the export clicked. */
const downloads: string[] = [];

interface FakeRequest {
	result: unknown;
	error: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
}

const request = (result: unknown): FakeRequest => {
	const req: FakeRequest = {
		result,
		error: null,
		onsuccess: null,
		onerror: null,
	};
	queueMicrotask(() => {
		if (requestsFail) {
			req.error = "indexeddb request failed";
			req.onerror?.();
			return;
		}
		req.onsuccess?.();
	});
	return req;
};

const objectStore = (): Record<string, () => FakeRequest> => ({
	getAll: () => request([]),
	get: () => request(null),
	put: () => request(null),
	delete: () => request(null),
});

const connection = (): unknown => ({
	transaction: () => ({
		objectStore: () => objectStore(),
		onabort: null,
		error: null,
	}),
	objectStoreNames: { contains: () => true },
	createObjectStore: () => {},
});

const databaseRequest = (): unknown => {
	const req = {
		result: connection(),
		error: null,
		onupgradeneeded: null as (() => void) | null,
		onsuccess: null as (() => void) | null,
		onerror: null as (() => void) | null,
	};
	queueMicrotask(() => {
		req.onupgradeneeded?.();
		req.onsuccess?.();
	});
	return req;
};

/** Install the two globals, returning the restore that puts the originals back. */
const installBrowser = (): (() => void) => {
	const globals = globalThis as { indexedDB?: unknown; document?: unknown };
	const previousIndexedDb = globals.indexedDB;
	const previousDocument = globals.document;
	const previousCreate = URL.createObjectURL;
	const previousRevoke = URL.revokeObjectURL;
	globals.indexedDB = { open: databaseRequest };
	globals.document = {
		createElement: () => {
			const anchor = {
				href: "",
				download: "",
				click: (): void => {
					downloads.push(anchor.download);
				},
			};
			return anchor;
		},
	};
	URL.createObjectURL = () => "blob:test";
	URL.revokeObjectURL = () => {};
	return () => {
		globals.indexedDB = previousIndexedDb;
		globals.document = previousDocument;
		URL.createObjectURL = previousCreate;
		URL.revokeObjectURL = previousRevoke;
	};
};

/** Poll for a state the fire-and-forget export reaches on another fibre. */
const waitFor = async (predicate: () => boolean): Promise<boolean> => {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return predicate();
};

/** Everything the logger wrote, flattened, with the spied consoles silenced. */
const captureLog = (): {
	readonly text: () => string;
	readonly restore: () => void;
} => {
	const spies = [
		spyOn(console, "log").mockImplementation(() => {}),
		spyOn(console, "warn").mockImplementation(() => {}),
		spyOn(console, "error").mockImplementation(() => {}),
	];
	const text = (): string =>
		spies
			.flatMap((spy) => spy.mock.calls)
			.flat()
			.map((value) => (typeof value === "string" ? value : String(value)))
			.join("\n");
	return {
		text,
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
};

let restoreBrowser = (): void => {};

beforeEach(() => {
	clearOverlay();
	downloads.length = 0;
	requestsFail = false;
	restoreBrowser = installBrowser();
});

afterEach(() => {
	restoreBrowser();
	clearOverlay();
	requestsFail = false;
});

describe("app.backup.export from the command palette", () => {
	test("a failed export raises an error toast, not just a log", async () => {
		const s = services();
		const log = captureLog();
		requestsFail = true;

		await runExport(s);
		const shown = await waitFor(() => getOverlaySnapshot().toasts.length > 0);
		const toasts = getOverlaySnapshot().toasts;
		const written = log.text();
		log.restore();

		// The toast is the load-bearing assertion: the failure is visible to a
		// user who ran the command from the palette, not only to the log.
		expect(shown).toBe(true);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.tone).toBe("error");
		expect(toasts[0]?.text).toContain("indexeddb request failed");
		// Nothing was downloaded: the failure returned before the bytes.
		expect(downloads).toHaveLength(0);
		// The log is kept alongside the toast.
		expect(written).toContain("failed to export a backup");
	});

	test("a successful export downloads the file and raises no toast", async () => {
		const s = services();
		requestsFail = false;

		await runExport(s);
		const delivered = await waitFor(() => downloads.length > 0);

		expect(delivered).toBe(true);
		expect(downloads[0] ?? "").toMatch(
			/^ai-client-backup-\d{4}-\d{2}-\d{2}\.json$/,
		);
		expect(getOverlaySnapshot().toasts).toHaveLength(0);
	});
});
