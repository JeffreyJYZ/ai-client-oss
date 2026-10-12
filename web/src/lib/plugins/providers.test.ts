import { describe, expect, spyOn, test } from "bun:test";
import { SendMsg } from "@lib/api";
import { registerProviderBuiltins } from "@lib/plugins/builtin/providers";
import { PluginFault } from "@lib/plugins/errors";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import {
	listProtocols,
	registerProvider,
	resolveProvider,
} from "@lib/plugins/providers";
import { anthropic } from "@lib/providers/anthropicMessages";
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";
import type { Provider, SendCtx } from "@lib/providers/types";
import { Cause, Effect, Exit, Option, Scope, Stream } from "effect";
import { z } from "zod";

/**
 * The provider registry (spec §5) proven the way `tools.test.ts` proves the
 * tool registry: a fresh `HostServices` per test (registrations are the
 * subject, so a shared one would leak protocols between tests), a `Host` per
 * registering plugin, and every read driven against that test's services.
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

/** A request ctx is irrelevant to resolution; the registry is the subject. */
const ctx = (): SendCtx => ({
	msg: "hi",
	prev: null,
	apiUrl: "https://example.test/v1",
	apiKey: "k",
	model: "m",
});

/** The wire body a fake protocol carries; only its shape matters here. */
const FakeBody = z.object({ text: z.string() });
type FakeBody = z.infer<typeof FakeBody>;

/**
 * A plugin's own protocol: a real `Provider` whose `send` yields exactly one
 * text chunk, so `SendMsg` streaming through it is observable. Every other
 * member is inert — resolution and the wire body are what these tests check.
 */
const fakeProvider: Provider<FakeBody> = {
	schema: FakeBody,
	endpoint: "/fake",
	template: { text: "" },
	parse: (raw) => Effect.succeed(FakeBody.parse(raw)),
	buildRequest: (send) => send,
	appendAssistant: (send, text) => ({ text: send.text + text }),
	seedHistory: () => ({ text: "" }),
	appendToolResult: (send) => send,
	headers: () => ({}),
	send: () =>
		Effect.succeed(
			Stream.make({ kind: "text" as const, text: "plugin reply" }),
		),
};

describe("providers registry", () => {
	test("the three built-ins register and resolve", async () => {
		const s = services();
		registerProviderBuiltins(host(s, "app.builtin"));

		expect(await runWith(listProtocols(), s)).toEqual([
			"anthropic",
			"responses",
			"chatcompletions",
		]);

		// The entry resolves to the very implementation, not a copy: `send` is
		// the object identity `SendMsg` will call.
		const found = await runWith(resolveProvider("anthropic"), s);
		expect(Option.isSome(found)).toBe(true);
		expect(Option.getOrThrow(found).send).toBe(anthropic.send);

		const chat = await runWith(resolveProvider("chatcompletions"), s);
		expect(Option.getOrThrow(chat).send).toBe(chatcompletions.send);
		const api = await runWith(resolveProvider("responses"), s);
		expect(Option.getOrThrow(api).send).toBe(responses.send);
	});

	test("an unknown protocol is a failed turn with a clear message, never a TypeError", async () => {
		const s = services();
		// Building the effect must not throw (no `undefined.send` dereference)...
		const effect = SendMsg("does-not-exist", ctx());
		expect(() => effect).not.toThrow();
		// ...and running it is a *typed* failure with the sentence, not a defect.
		const exit = await runWith(Effect.exit(effect), s);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			// `findErrorOption` finds a typed `Fail` and returns `none` for a
			// defect, so this equality is also the proof there was no thrown
			// `TypeError` to catch.
			expect(Cause.findErrorOption(exit.cause)).toEqual(
				Option.some("unknown protocol: does-not-exist"),
			);
		}
	});

	test("a plugin protocol resolves and SendMsg streams through it", async () => {
		const s = services();
		registerProvider(
			host(s, "acme.protocols"),
			"acme.fake",
			fakeProvider,
			"acme.protocols",
		);

		const found = await runWith(resolveProvider("acme.fake"), s);
		expect(Option.isSome(found)).toBe(true);
		expect(Option.getOrThrow(found).send).toBe(fakeProvider.send);

		const stream = await runWith(SendMsg("acme.fake", ctx()), s);
		const chunks = await Effect.runPromise(Stream.runCollect(stream));
		expect([...chunks]).toEqual([{ kind: "text", text: "plugin reply" }]);
	});

	test("a plugin's same-name protocol is refused with a PluginFault and the built-in wins", async () => {
		const s = services();
		registerProviderBuiltins(host(s, "app.builtin"));

		const logged = spyOn(console, "log");
		const handle = registerProvider(
			host(s, "acme.protocols"),
			"anthropic",
			fakeProvider,
			"acme.protocols",
		);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		const faults = calls.filter((value) => value instanceof PluginFault);
		expect(faults).toHaveLength(1);
		expect((faults[0] as PluginFault).pluginId).toBe("acme.protocols");
		expect((faults[0] as PluginFault).detail).toContain("anthropic");

		// The refused registration left no trace: the built-in is the only
		// "anthropic", and it is what resolves.
		expect(await runWith(listProtocols(), s)).toEqual([
			"anthropic",
			"responses",
			"chatcompletions",
		]);
		const found = await runWith(resolveProvider("anthropic"), s);
		expect(Option.getOrThrow(found).send).toBe(anthropic.send);
		// Its handle is inert, never a remover for the built-in.
		expect(() => handle.dispose()).not.toThrow();
		expect(await runWith(listProtocols(), s)).toEqual([
			"anthropic",
			"responses",
			"chatcompletions",
		]);
	});

	test("a blank name is refused rather than stored", async () => {
		const s = services();
		const logged = spyOn(console, "log");
		const handle = registerProvider(
			host(s, "acme.protocols"),
			"  ",
			fakeProvider,
		);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(calls.filter((value) => value instanceof PluginFault)).toHaveLength(
			1,
		);
		expect(await runWith(listProtocols(), s)).toEqual([]);
		expect(() => handle.dispose()).not.toThrow();
	});
});

describe("protocol registration and send isolation (spec §9)", () => {
	/** The fake protocol with its `send` overridden, for one focused probe. */
	const withSend = (send: Provider<FakeBody>["send"]): Provider<FakeBody> => ({
		...fakeProvider,
		send,
	});

	test("a protocol whose send is not callable is refused with a PluginFault", async () => {
		const s = services();
		const logged = spyOn(console, "log");
		registerProvider(
			host(s, "acme.protocols"),
			"acme.nosend",
			withSend(undefined as unknown as Provider<FakeBody>["send"]),
			"acme.protocols",
		);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
		expect(await runWith(listProtocols(), s)).not.toContain("acme.nosend");
	});

	test("a send that throws is isolated into the string channel with a PluginFault", async () => {
		const s = services();
		registerProvider(
			host(s, "acme.protocols"),
			"acme.throw",
			withSend(() => {
				throw new Error("boom");
			}),
			"acme.protocols",
		);
		const logged = spyOn(console, "log");
		const exit = await runWith(Effect.exit(SendMsg("acme.throw", ctx())), s);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		// A typed `string` failure, never a defect: `findErrorOption` finds it.
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
		}
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
	});

	test("a send whose stream defects is isolated into the string channel with a PluginFault", async () => {
		const s = services();
		registerProvider(
			host(s, "acme.protocols"),
			"acme.die",
			withSend(() => Effect.succeed(Stream.die(new Error("stream boom")))),
			"acme.protocols",
		);
		const logged = spyOn(console, "log");
		const exit = await runWith(
			Effect.gen(function* () {
				const stream = yield* SendMsg("acme.die", ctx());
				return yield* Effect.exit(Stream.runCollect(stream));
			}),
			s,
		);
		const calls = logged.mock.calls.flat();
		logged.mockRestore();

		// The defect is turned into the same graceful `string` failure every
		// other turn failure takes, and it is logged.
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
		}
		expect(calls.some((value) => value instanceof PluginFault)).toBe(true);
	});
});
