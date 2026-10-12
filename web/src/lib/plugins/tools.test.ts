import { describe, expect, spyOn, test } from "bun:test";
import { fetchUrlBuiltin } from "@lib/plugins/builtin/tools/fetchUrl";
import { webSearchBuiltin } from "@lib/plugins/builtin/tools/webSearch";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import {
	executeTool,
	registerTool,
	resolveTool,
	type Tool,
} from "@lib/plugins/tools";
import { fetchUrlTool, webSearchTool } from "@lib/providers/presets";
import type { ToolCallData } from "@lib/providers/types";
import { Effect, Option, Scope } from "effect";

/**
 * A fresh registry set per test: registrations are the subject, so a shared
 * `HostServices` would leak tools between tests (the `host.test.ts` pattern).
 */
const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

const scope = (): Scope.Closeable => Effect.runSync(Scope.make());

const host = (s: HostServicesShape, id: string): ReturnType<typeof makeHost> =>
	makeHost(s, id, scope());

/** Run a registry-reading effect against one test's services. */
const runWith = <A, E>(
	effect: Effect.Effect<A, E, HostServices>,
	s: HostServicesShape,
): Promise<A> =>
	Effect.runPromise(Effect.provideService(effect, HostServices, s));

const call = (name: string, args: string): ToolCallData => ({
	id: "call-1",
	key: "0",
	name,
	args,
});

/** The flat (Responses) envelope a declaration must match. */
const flat = (
	tool: unknown,
): {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
} =>
	tool as {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};

type FetchAnswer = unknown | Response | undefined;

/**
 * Replace `globalThis.fetch` for one test. The TinyFish client reads the
 * global, so this exercises the real `searchWeb`/`fetchUrlText` without a
 * network — no project module is mocked (R13 forbids that; a global is not a
 * module). An `undefined` answer rejects, so an unexpected URL fails loudly.
 */
const stubFetch = (respond: (url: string) => FetchAnswer): (() => void) => {
	const original = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL) => {
		const answer = respond(String(input));
		if (answer === undefined) {
			return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
		}
		if (answer instanceof Response) return Promise.resolve(answer);
		return Promise.resolve(
			new Response(JSON.stringify(answer), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
};

describe("tools registry", () => {
	test("a registered tool executes and its outcome reaches the loop shape", async () => {
		const s = services();
		const h = host(s, "acme.tools");
		const declaration = {
			name: "echo",
			description: "Echoes its arguments.",
			parameters: { type: "object" },
		};
		const tool: Tool = {
			declaration,
			execute: (input, ctx) =>
				Effect.succeed({
					result: `echo:${JSON.stringify(input)}:${ctx.tinyfishApiKey ?? "no-key"}`,
					marker: "🔧 echoed",
					failed: false,
					input,
				}),
		};
		registerTool(h, tool, "acme.tools");

		// The declaration and the executor survive the registry round trip.
		const resolved = await runWith(resolveTool("echo"), s);
		expect(Option.isSome(resolved)).toBe(true);
		expect(Option.getOrThrow(resolved).declaration).toEqual(declaration);
		expect(Effect.runSync(s.tools.ownedBy("acme.tools")).length).toBe(1);

		const outcome = await runWith(
			executeTool("echo", call("echo", '{"q":"hi"}'), {
				tinyfishApiKey: "tf-key",
			}),
			s,
		);
		expect(outcome).toEqual({
			result: 'echo:{"q":"hi"}:tf-key',
			marker: "🔧 echoed",
			failed: false,
			input: { q: "hi" },
		});
	});

	test("an unknown tool name yields a failed outcome with a readable sentence and never throws", async () => {
		const s = services();
		const effect = executeTool(
			"does_not_exist",
			call("does_not_exist", '{"q":"hi"}'),
		);
		// Building the outcome is synchronous and must not throw...
		expect(() => effect).not.toThrow();
		// ...and the loop's invariant holds: a string result, never a rejection.
		const outcome = await runWith(effect, s);
		expect(outcome.failed).toBe(true);
		expect(typeof outcome.result).toBe("string");
		expect(outcome.result).toBe("No tool named does_not_exist is registered.");
		expect(outcome.input).toEqual({ q: "hi" });
	});

	test("arguments that are not JSON are a null input, not a failure of the call", async () => {
		const s = services();
		const tool: Tool = {
			declaration: {
				name: "probe",
				description: "Reports the input it saw.",
				parameters: { type: "object" },
			},
			execute: (input) =>
				Effect.succeed({
					result: "ok",
					marker: "🔧 probe",
					failed: false,
					input,
				}),
		};
		registerTool(host(s, "acme.tools"), tool, "acme.tools");
		const outcome = await runWith(
			executeTool("probe", call("probe", "not json")),
			s,
		);
		expect(outcome.input).toBeNull();
		expect(outcome.failed).toBe(false);
	});

	test("a plugin's same-name tool is refused with a PluginFault and the built-in wins at resolve time", async () => {
		const s = services();
		// Built-ins register first, through the same registrar a plugin uses.
		registerTool(host(s, "app.builtin"), fetchUrlBuiltin, "app.builtin");

		const intruder: Tool = {
			declaration: {
				name: "fetch_url",
				description: "A plugin's competing fetch.",
				parameters: { type: "object" },
			},
			execute: () =>
				Effect.succeed({
					result: "plugin",
					marker: "🔧 plugin fetch",
					failed: false,
					input: null,
				}),
		};

		const logged = spyOn(console, "log");
		const refusedHost = host(s, "acme.tools");
		const handle = registerTool(refusedHost, intruder, "acme.tools");
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		const faults = calls.filter((value) => value instanceof PluginFault);
		expect(faults).toHaveLength(1);
		expect((faults[0] as PluginFault).pluginId).toBe("acme.tools");
		expect((faults[0] as PluginFault).detail).toContain("fetch_url");

		// The refused registration left no trace: the built-in is the only entry
		// and it is what resolves, so the built-in wins.
		expect(Effect.runSync(s.tools.entries()).map((entry) => entry.id)).toEqual([
			"fetch_url",
		]);
		const resolved = await runWith(resolveTool("fetch_url"), s);
		expect(Option.getOrThrow(resolved).execute).toBe(fetchUrlBuiltin.execute);
		// Its handle is inert, never a remover for the built-in.
		expect(() => handle.dispose()).not.toThrow();
		expect(Effect.runSync(s.tools.entries()).map((entry) => entry.id)).toEqual([
			"fetch_url",
		]);
	});
});

describe("built-in tool declarations", () => {
	test("match the wire declarations presets.ts builds", () => {
		const fetch = flat(fetchUrlTool("responses"));
		expect(fetchUrlBuiltin.declaration).toEqual({
			name: fetch.name,
			description: fetch.description,
			parameters: fetch.parameters,
		});
		const search = flat(webSearchTool("responses"));
		expect(webSearchBuiltin.declaration).toEqual({
			name: search.name,
			description: search.description,
			parameters: search.parameters,
		});
	});
});

describe("fetch_url markers", () => {
	test("a fetched page keeps its exact marker", async () => {
		const restore = stubFetch((url) =>
			url.includes("api.fetch.tinyfish.ai")
				? { results: [{ text: "hello world" }] }
				: undefined,
		);
		try {
			const outcome = await Effect.runPromise(
				fetchUrlBuiltin.execute(
					{ url: "https://example.com/page" },
					{ tinyfishApiKey: "tf-key" },
				),
			);
			expect(outcome).toEqual({
				result: "hello world",
				marker: "🔗 fetched example.com (11 chars)",
				failed: false,
				input: { url: "https://example.com/page" },
			});
		} finally {
			restore();
		}
	});

	test("a failed fetch keeps its exact sentence and marker", async () => {
		const restore = stubFetch(() => new Response("nope", { status: 500 }));
		try {
			const outcome = await Effect.runPromise(
				fetchUrlBuiltin.execute(
					{ url: "https://example.com/page" },
					{ tinyfishApiKey: "tf-key" },
				),
			);
			expect(outcome.failed).toBe(true);
			expect(outcome.result).toBe("The site answered with HTTP status 500.");
			expect(outcome.marker).toBe(
				"🔗 fetch failed: The site answered with HTTP status 500.",
			);
		} finally {
			restore();
		}
	});

	test("a call with no URL is a failure sentence, no fetch attempted", async () => {
		const restore = stubFetch(() => undefined);
		try {
			const outcome = await Effect.runPromise(
				fetchUrlBuiltin.execute({}, { tinyfishApiKey: "tf-key" }),
			);
			expect(outcome).toEqual({
				result: "fetch_url was called without a URL.",
				marker: "🔗 fetch failed: fetch_url was called without a URL.",
				failed: true,
				input: {},
			});
		} finally {
			restore();
		}
	});
});

describe("web_search markers", () => {
	const hits = (n: number): unknown => ({
		results: Array.from({ length: n }, (_, index) => ({
			title: `Result ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			snippet: `snippet ${index + 1}`,
		})),
	});

	test("two results read as a plural marker and the trimmed query", async () => {
		const restore = stubFetch((url) =>
			url.includes("api.search.tinyfish.ai") ? hits(2) : undefined,
		);
		try {
			const outcome = await Effect.runPromise(
				webSearchBuiltin.execute(
					{ query: "  effect  " },
					{ tinyfishApiKey: "tf-key" },
				),
			);
			expect(outcome.failed).toBe(false);
			expect(outcome.marker).toBe("🔍 searched the web: 2 results");
			expect(outcome.result).toContain('Search results for "effect":');
		} finally {
			restore();
		}
	});

	test("one result reads as a singular marker", async () => {
		const restore = stubFetch((url) =>
			url.includes("api.search.tinyfish.ai") ? hits(1) : undefined,
		);
		try {
			const outcome = await Effect.runPromise(
				webSearchBuiltin.execute(
					{ query: "effect" },
					{ tinyfishApiKey: "tf-key" },
				),
			);
			expect(outcome.marker).toBe("🔍 searched the web: 1 result");
		} finally {
			restore();
		}
	});

	test("a search with no results keeps its exact sentence and marker", async () => {
		const restore = stubFetch((url) =>
			url.includes("api.search.tinyfish.ai") ? { results: [] } : undefined,
		);
		try {
			const outcome = await Effect.runPromise(
				webSearchBuiltin.execute(
					{ query: "effect" },
					{ tinyfishApiKey: "tf-key" },
				),
			);
			expect(outcome.failed).toBe(true);
			expect(outcome.marker).toBe(
				"🔍 search failed: The search returned no results.",
			);
		} finally {
			restore();
		}
	});

	test("a call with no query is a failure sentence, no search attempted", async () => {
		const restore = stubFetch(() => undefined);
		try {
			const outcome = await Effect.runPromise(
				webSearchBuiltin.execute({}, { tinyfishApiKey: "tf-key" }),
			);
			expect(outcome).toEqual({
				result: "web_search was called without a query.",
				marker: "🔍 search failed: web_search was called without a query.",
				failed: true,
				input: {},
			});
		} finally {
			restore();
		}
	});
});
