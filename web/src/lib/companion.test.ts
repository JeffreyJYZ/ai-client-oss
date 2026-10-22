import { describe, expect, test } from "bun:test";
import { companionStatus, pair, readStoredToken, unpair } from "@lib/companion";
import { Effect } from "effect";

const installStorage = (token: string | null): void => {
	const map = new Map<string, string>();
	if (token !== null) map.set("ai-client.companion", JSON.stringify({ token }));
	const storage: Storage = {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		},
	} as unknown as Storage;
	(globalThis as { localStorage?: Storage }).localStorage = storage;
};

describe("companion status", () => {
	test("absent when the fetch rejects", async () => {
		installStorage(null);
		const status = await Effect.runPromise(
			companionStatus({ fetch: () => Promise.reject(new Error("refused")) }),
		);
		expect(status).toBe("absent");
	});

	test("absent when the probe times out", async () => {
		installStorage(null);
		const status = await Effect.runPromise(
			companionStatus({
				fetch: (_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal as AbortSignal | undefined;
						if (signal !== undefined) {
							signal.addEventListener("abort", () =>
								reject(new DOMException("aborted", "AbortError")),
							);
						}
					}),
			}),
		);
		expect(status).toBe("absent");
	});

	test("unpaired when the daemon answers and no token is stored", async () => {
		installStorage(null);
		const status = await Effect.runPromise(
			companionStatus({
				fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
			}),
		);
		expect(status).toBe("unpaired");
	});

	test("paired when the daemon answers and a token is stored", async () => {
		installStorage("tok-1");
		const status = await Effect.runPromise(
			companionStatus({
				fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
			}),
		);
		expect(status).toBe("paired");
	});
});

describe("pair", () => {
	test("stores the token on 200", async () => {
		installStorage(null);
		let body = "";
		await Effect.runPromise(
			pair("  tok-1  ", {
				fetch: (_url, init) => {
					body = String(init?.body ?? "");
					return Promise.resolve(new Response("{}", { status: 200 }));
				},
			}),
		);
		expect(body).toBe(JSON.stringify({ token: "tok-1" }));
		expect(await Effect.runPromise(readStoredToken())).toBe("tok-1");
	});

	test("a 401 fails with a readable sentence and does not store", async () => {
		installStorage(null);
		let thrown: string | null = null;
		try {
			await Effect.runPromise(
				pair("wrong", {
					fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
				}),
			);
		} catch (error) {
			thrown = String(error);
		}
		// Effect failures surface through Effect.runPromise as thrown errors.
		expect(thrown).not.toBeNull();
		expect(await Effect.runPromise(readStoredToken())).toBeNull();
	});

	test("an empty token fails without a fetch", async () => {
		installStorage(null);
		let calls = 0;
		let failed = false;
		try {
			await Effect.runPromise(
				pair("   ", {
					fetch: () => {
						calls += 1;
						return Promise.resolve(new Response("{}", { status: 200 }));
					},
				}),
			);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		expect(calls).toBe(0);
	});
});

describe("unpair", () => {
	test("removes the stored token", async () => {
		installStorage("tok-1");
		await Effect.runPromise(unpair());
		expect(await Effect.runPromise(readStoredToken())).toBeNull();
	});
});

describe("storage read failure", () => {
	test("behaves as unpaired when localStorage throws", async () => {
		(globalThis as { localStorage?: Storage }).localStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => undefined,
			removeItem: () => undefined,
			clear: () => undefined,
			key: () => null,
			get length() {
				return 0;
			},
		} as unknown as Storage;
		const token = await Effect.runPromise(readStoredToken());
		expect(token).toBeNull();
		const status = await Effect.runPromise(
			companionStatus({
				fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
			}),
		);
		expect(status).toBe("unpaired");
	});
});
