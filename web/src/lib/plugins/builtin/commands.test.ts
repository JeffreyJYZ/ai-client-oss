import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerCommandBuiltins } from "@lib/plugins/builtin/commands";
import { runCommand } from "@lib/plugins/commands";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import {
	clearOverlay,
	getOverlaySnapshot,
	type OverlayState,
	subscribeOverlay,
} from "@lib/plugins/notify";
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

/**
 * Woken by the fake anchor's click. The download has no store event of its own,
 * so the signal the product emits here is the browser seam itself — the
 * `anchor.click()` inside `downloadBackup`. Waiting on it keeps the test driven
 * by the code path that performs the download rather than by a wall clock; a
 * download the product never performs leaves the wait unsettled, so the test
 * fails on bun's own timeout instead of being papered over.
 */
let resolveDownload: (() => void) | null = null;

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
					resolveDownload?.();
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

/**
 * Wait for the overlay to reach a state, driven by the store's own subscription
 * rather than a wall clock.
 *
 * `commit` writes the ref and the React projection, then wakes the listeners,
 * all in one synchronous step (`notify.ts`), so a listener that re-checks on
 * every change cannot miss an entry that landed between checks — and the
 * current snapshot is tested once up front as well. No `Date.now()` bounds the
 * wait, so a machine sleep or a process pause cannot make it give up while the
 * toast is still in flight — the flake the replaced `Date.now() + 2000`
 * deadline produced. It still detects a toast that never arrives: the promise
 * settles only on a real overlay change, so a missing toast fails on bun's own
 * test timeout.
 */
const waitForOverlay = (
	predicate: (state: OverlayState) => boolean,
): Promise<OverlayState> =>
	new Promise((resolve) => {
		let dispose: () => void = () => {};
		const check = (): void => {
			const state = getOverlaySnapshot();
			if (predicate(state)) {
				dispose();
				resolve(state);
			}
		};
		dispose = subscribeOverlay(check);
		check();
	});

/** Wait for the fake anchor's click, the delivery step the export performs. */
const waitForDownload = (): Promise<void> =>
	new Promise((resolve) => {
		if (downloads.length > 0) {
			resolve();
			return;
		}
		resolveDownload = resolve;
	});

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
	resolveDownload = null;
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
		const shown = await waitForOverlay((state) => state.toasts.length > 0);
		const toasts = shown.toasts;
		const written = log.text();
		log.restore();

		// The toast is the load-bearing assertion: the failure is visible to a
		// user who ran the command from the palette, not only to the log.
		expect(toasts.length).toBeGreaterThan(0);
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

		// Subscribe before the export so its download signal cannot be missed.
		const downloaded = waitForDownload();
		await runExport(s);
		await downloaded;

		expect(downloads).toHaveLength(1);
		expect(downloads[0] ?? "").toMatch(
			/^ai-client-backup-\d{4}-\d{2}-\d{2}\.json$/,
		);
		expect(getOverlaySnapshot().toasts).toHaveLength(0);
	});
});
