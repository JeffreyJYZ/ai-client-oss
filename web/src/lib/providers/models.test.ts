import { describe, expect, test } from "bun:test";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import { registerProvider } from "@lib/plugins/providers";
import {
	PROBE_SESSION_ID,
	probeConnection,
	testModel,
} from "@lib/providers/models";
import {
	type ChatIpc,
	type ChatRequest,
	nativeTransportWith,
} from "@lib/providers/transport";
import type { Provider } from "@lib/providers/types";
import { Cause, Effect, Exit, Option, Scope, Stream } from "effect";
import { z } from "zod";

/**
 * The models/connection helpers against a plugin protocol (spec §5). A
 * protocol's members are plugin code at this boundary: `registerProvider`
 * validates only `send`, so `headers` and `buildRequest` are untyped
 * JavaScript the helper calls. This suite proves the probe reduces every one
 * of those to the `string` channel — never a defect a caller's typed `catch`
 * would miss and leave the "Test connection" button silently reset.
 */

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const run = <A, E>(
	effect: Effect.Effect<A, E, HostServices>,
	s: HostServicesShape,
): Promise<A> =>
	Effect.runPromise(Effect.provideService(effect, HostServices, s));

/** A plugin protocol whose probe shape is its own, not chat-completions. */
const probePlugin = (
	over: Partial<Provider<{ probe: string }>> = {},
): Provider<{ probe: string }> => ({
	schema: z.object({ probe: z.string() }),
	endpoint: "/plugin",
	template: { probe: "" },
	parse: (raw) => Effect.succeed({ probe: String(raw) }),
	buildRequest: (send) => send,
	appendAssistant: (send) => send,
	seedHistory: () => ({ probe: "" }),
	appendToolResult: (send) => send,
	headers: () => ({}),
	send: () => Effect.succeed(Stream.empty),
	...over,
});

const register = (
	s: HostServicesShape,
	id: string,
	provider: Provider<{ probe: string }>,
): void => {
	registerProvider(makeHost(s, id, scope()), id, provider, id);
};

describe("testModel isolates a plugin protocol's own members", () => {
	test("a `headers` that throws is a typed message, not a defect", async () => {
		const s = services();
		register(
			s,
			"test.headers",
			probePlugin({
				headers: () => {
					throw new Error("no headers");
				},
			}),
		);

		const exit = await run(
			Effect.exit(
				testModel("test.headers", "https://x.test/v1", undefined, "m1"),
			),
			s,
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			// `findErrorOption` finds a typed `Fail` and is `none` for a defect,
			// so this is also the proof the throw never escaped as a defect.
			expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
		}
	});

	test("a plugin throw whose own `String` throws is still a typed message", async () => {
		const s = services();
		register(
			s,
			"test.unprintable",
			probePlugin({
				headers: () => {
					throw {
						toString() {
							throw new Error("unprintable");
						},
					};
				},
			}),
		);

		const exit = await run(
			Effect.exit(
				testModel("test.unprintable", "https://x.test/v1", undefined, "m1"),
			),
			s,
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			// A defect leaves `findErrorOption` empty — the silent reset the
			// seam exists to prevent.
			expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
		}
	});

	test("a plugin header value whose own `String` throws is still a typed message", async () => {
		// Verified against the installed runtime: when a plugin-supplied header
		// value's own coercion throws, `fetch` rejects with the value that
		// coercion threw — so the rejection reason is plugin code too.
		const s = services();
		register(
			s,
			"test.evilheader",
			probePlugin({
				headers: () => ({
					"x-evil": {
						toString() {
							throw {
								toString() {
									throw new Error("unprintable");
								},
							};
						},
					} as unknown as string,
				}),
			}),
		);

		const exit = await run(
			Effect.exit(
				testModel("test.evilheader", "https://x.test/v1", undefined, "m1"),
			),
			s,
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
		}
	});
});

/**
 * The two halves the button must show: a plugin member that **throws**
 * (`headers`) and a probe whose request **fails** (the protocol's own error
 * channel). Each must reach `probeConnection`'s returned line — the "visible
 * message" — never a silent reset. (`send` is not on this path: `testModel`
 * builds its own probe shape and never calls it; a `send` that throws is
 * isolated and surfaced at the `SendMsg` seam, asserted in
 * `plugins/providers.test.ts`.)
 */
describe("probeConnection always yields a visible line", () => {
	/** Swap `fetch` for one probe, restoring it after — always restored. */
	const withFetch = async <A>(
		replacement: typeof fetch,
		probe: () => Promise<A>,
	): Promise<A> => {
		const original = globalThis.fetch;
		globalThis.fetch = replacement;
		try {
			return await probe();
		} finally {
			globalThis.fetch = original;
		}
	};

	test("a `headers` that throws becomes a failure line, not a silent reset", async () => {
		const s = services();
		register(
			s,
			"test.headers",
			probePlugin({
				headers: () => {
					throw new Error("no headers");
				},
			}),
		);

		const message = await run(
			probeConnection("test.headers", "https://x.test/v1", undefined, "m1"),
			s,
		);

		expect(message.startsWith("✓")).toBe(false);
		expect(message).toContain("test.headers");
	});

	test("a missing `headers` is a failure line, not a defect", async () => {
		const s = services();
		register(
			s,
			"test.noheaders",
			probePlugin({
				headers: undefined as unknown as Provider<{
					probe: string;
				}>["headers"],
			}),
		);

		const message = await run(
			probeConnection("test.noheaders", "https://x.test/v1", undefined, "m1"),
			s,
		);

		// `registerProvider` validates only `send`, so an absent `headers` is a
		// real registered protocol — a `TypeError` at the call, not a refusal.
		expect(message.startsWith("✓")).toBe(false);
	});

	test("a probe whose request fails becomes a failure line", async () => {
		const s = services();
		register(s, "test.reject", probePlugin());

		const message = await withFetch(
			(() =>
				Promise.reject(new Error("network down"))) as unknown as typeof fetch,
			() =>
				run(
					probeConnection("test.reject", "https://x.test/v1", undefined, "m1"),
					s,
				),
		);

		expect(message.startsWith("✓")).toBe(false);
		expect(message).toContain("network down");
	});

	test("a successful probe reports the model", async () => {
		const s = services();
		register(s, "test.ok", probePlugin());

		const message = await withFetch(
			(() =>
				Promise.resolve(
					new Response("", { status: 200 }),
				)) as unknown as typeof fetch,
			() =>
				run(
					probeConnection("test.ok", "https://x.test/v1", undefined, "m1"),
					s,
				),
		);

		expect(message).toBe("✓ m1 responded");
	});
});

/**
 * The probe against the desktop transport. `nativeTransportWith(ipc)` is the
 * production transport over its own seam, so these drive the real assembly —
 * the status gate, the body, the cancel, the assembled headers — with the
 * shell's own contract. What a unit test cannot show is the `isDesktop` choice
 * and the live `Channel` wiring, which the committed desktop stub covers
 * (`scripts/desktop-stub.js`).
 */
describe("the probe rides the chat transport", () => {
	/** A scripted shell: records every request, then relays one scripted result. */
	const fakeShell = (outcome: {
		readonly status?: number;
		readonly chunks?: readonly string[];
		readonly reject?: string;
	}): {
		readonly ipc: ChatIpc;
		readonly started: ChatRequest[];
		readonly cancels: string[];
	} => {
		const started: ChatRequest[] = [];
		const cancels: string[] = [];
		return {
			started,
			cancels,
			ipc: {
				start: (request, onMessage) => {
					started.push(request);
					if (outcome.reject !== undefined)
						return Promise.reject(outcome.reject);
					onMessage({ type: "status", status: outcome.status ?? 200 });
					for (const text of outcome.chunks ?? [])
						onMessage({ type: "chunk", text });
					onMessage({ type: "end" });
					return Promise.resolve();
				},
				cancel: (requestId) => {
					cancels.push(requestId);
					return Promise.resolve();
				},
			},
		};
	};

	test("its POST goes through the transport it was given, session included", async () => {
		const s = services();
		// A protocol whose `buildRequest` marks the body as its own, so the
		// assertion below distinguishes it from a hardcoded shape.
		register(
			s,
			"test.rides",
			probePlugin({
				template: { probe: "template" },
				buildRequest: (_send, ctx) => ({ probe: ctx.msg }),
			}),
		);
		const shell = fakeShell({ status: 200 });

		await run(
			testModel(
				"test.rides",
				"https://opencode.ai/inference/go/v1",
				undefined,
				"m1",
				nativeTransportWith(shell.ipc),
			),
			s,
		);

		// The shell saw the probe's own request, at the family-agnostic Go base
		// plus the protocol's endpoint, carrying the session header.
		expect(shell.started).toHaveLength(1);
		expect(shell.started[0].url).toBe(
			"https://opencode.ai/inference/go/v1/plugin",
		);
		expect(shell.started[0].headers["x-opencode-session"]).toBe(
			PROBE_SESSION_ID,
		);
		// The body is the protocol's own `buildRequest` over its own template.
		expect(shell.started[0].body).toBe(JSON.stringify({ probe: "ping" }));
		// A 2xx is enough: the probe does not read the body, so it releases the
		// request instead of leaving it open.
		expect(shell.cancels).toEqual([shell.started[0].requestId]);
	});

	test("the session header is absent for every other host", async () => {
		const s = services();
		const hosts = [
			"https://openrouter.ai/api/v1",
			"https://api.commandcode.ai/provider/v1",
			"https://api.openai.com/v1",
			"https://api.anthropic.com/v1",
			"http://localhost:11434/v1",
		] as const;
		for (const [index, host] of hosts.entries()) {
			const id = `test.host${index}`;
			register(s, id, probePlugin());
			const shell = fakeShell({ status: 200 });

			await run(
				testModel(id, host, undefined, "m1", nativeTransportWith(shell.ipc)),
				s,
			);

			expect(Object.keys(shell.started[0].headers), host).not.toContain(
				"x-opencode-session",
			);
		}
	});

	test("a non-2xx is still the readable failure line", async () => {
		const s = services();
		register(s, "test.notfound", probePlugin());
		const shell = fakeShell({
			status: 404,
			chunks: ['{"error":"no such model"}'],
		});

		const message = await run(
			probeConnection(
				"test.notfound",
				"https://opencode.ai/inference/go/v1",
				undefined,
				"m1",
				nativeTransportWith(shell.ipc),
			),
			s,
		);

		// The same line the webview path produced, from the shell's relayed
		// status and body.
		expect(message).toBe('404: {"error":"no such model"}');
	});

	test("a transport that fails before its status is still one visible line", async () => {
		const s = services();
		register(s, "test.refused", probePlugin());
		const shell = fakeShell({ reject: "failed to send POST https://…" });

		const message = await run(
			probeConnection(
				"test.refused",
				"https://opencode.ai/inference/go/v1",
				undefined,
				"m1",
				nativeTransportWith(shell.ipc),
			),
			s,
		);

		expect(message.startsWith("✓")).toBe(false);
		expect(message).toContain("failed to send POST");
	});
});
