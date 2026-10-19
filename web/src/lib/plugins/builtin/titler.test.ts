import { describe, expect, spyOn, test } from "bun:test";
import { BUILTIN_AREAS } from "@lib/plugins/areas";
import { makeBuiltinsReconciler } from "@lib/plugins/builtin";
import {
	registerTitlerBuiltins,
	type TitlerConversation,
	type TitlerDeps,
	type TitlerTarget,
} from "@lib/plugins/builtin/titler";
import {
	type Host,
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { ProviderEntry } from "@lib/plugins/providers";
import type { TitlerOutcome } from "@lib/titlerStatus";
import { Deferred, Effect, Exit, Scope } from "effect";
import type { UserMessageSignal } from "@/state/chat";

/**
 * The `app.titler` area: the trigger, the two scoped runs, and the write-back.
 *
 * Every collaborator is injected ({@link TitlerDeps}), for the reason the
 * memory area injects its settings source: a test that published through the
 * real store's private signal, or resolved a model through the real settings
 * store, would leak state into every later suite in the same bun process (one
 * module registry, order dependent). The injected `titleFor` is also the
 * request **counter** — "off means zero requests" is an assertion about the
 * request, never about the title.
 *
 * `writeTitle` stands in for T1b's `titleIfDerived` (which has its own suite):
 * it re-checks the conversation's existence and source in one step over the
 * test's own map, so "a rename wins" and "deleted mid-flight" exercise the
 * real refusal shape.
 */

const providerStub = (): ProviderEntry =>
	({ id: "titler-protocol", owner: "app.titler" }) as unknown as ProviderEntry;

const target = (model = "free-model"): TitlerTarget => ({
	provider: providerStub(),
	baseUrl: "https://example.test/v1",
	apiKey: "key",
	model,
});

/** One message after this send's append that the harness deletes: the count is all that matters. */
const firstMessage = (): readonly unknown[] => [{}];

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

/** Let a forked fibre's continuations run. */
const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

const settle = async (): Promise<void> => {
	for (let spins = 0; spins < 10; spins += 1) await tick();
};

const SIGNAL: UserMessageSignal = {
	conversationId: "c1",
	text: "How do I bake bread?",
};

interface Options {
	/** The resolved provider+credentials+model; `undefined` is the honest no-op. */
	readonly resolve?: () => TitlerTarget | undefined;
	/** The request, per signal. Defaults to a title that comes back immediately. */
	readonly titleFor?: TitlerDeps["titleFor"];
	readonly conversations?: readonly (readonly [string, TitlerConversation])[];
}

/**
 * The injected collaborators, plus the observations a test asserts on. Separate
 * from {@link makeHarness} so a test can drive a different host (the
 * reconciler) with the same seams.
 */
const makeDeps = (options: Options = {}) => {
	const handlers = new Set<(signal: UserMessageSignal) => void>();
	const conversations = new Map<string, TitlerConversation>(
		options.conversations ?? [],
	);
	const titles = new Map<string, string>();
	const writes: [string, string][] = [];
	const outcomes: TitlerOutcome[] = [];
	let requests = 0;

	const deps: TitlerDeps = {
		subscribe: (handler) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		readConversation: (id) => conversations.get(id),
		resolveTarget: options.resolve ?? (() => target()),
		titleFor: (input) => {
			requests += 1;
			return (options.titleFor ?? (() => Effect.succeed("A Model Title")))(
				input,
			);
		},
		// T1b's rule, over the test's own map: refuse a conversation that is gone
		// or already owned.
		writeTitle: (id, title) => {
			const conversation = conversations.get(id);
			if (conversation === undefined) return false;
			if (
				conversation.titleSource === "user" ||
				conversation.titleSource === "model"
			) {
				return false;
			}
			conversations.set(id, { ...conversation, titleSource: "model" });
			titles.set(id, title);
			writes.push([id, title]);
			return true;
		},
		recordOutcome: (outcome) => {
			outcomes.push(outcome);
		},
	};

	return {
		deps,
		conversations,
		titles,
		writes: (): readonly [string, string][] => writes,
		outcomes: (): readonly TitlerOutcome[] => outcomes,
		requests: (): number => requests,
		subscriptions: (): number => handlers.size,
		setConversation: (id: string, conversation: TitlerConversation): void => {
			conversations.set(id, conversation);
		},
		/** Publish one signal to whoever is subscribed (the store's own step). */
		emit: (signal: UserMessageSignal): void => {
			for (const handler of [...handlers]) handler(signal);
		},
	};
};

/** A registered area over a scope the test owns, so it can close it (toggle off). */
const makeHarness = async (options: Options = {}) => {
	const harness = makeDeps(options);
	const scope = Effect.runSync(Scope.make());
	registerTitlerBuiltins(
		makeHost(services(), "app.titler", scope),
		harness.deps,
	);
	// The subscription is installed by the scoped run's acquire, which is forked.
	await settle();
	return {
		...harness,
		close: (): Promise<void> =>
			Effect.runPromise(Scope.close(scope, Exit.void)),
	};
};

describe("the app.titler area", () => {
	test("the first user message titles the conversation", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
		});

		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(1);
		expect(h.writes()).toEqual([["c1", "A Model Title"]]);
		expect(h.titles.get("c1")).toBe("A Model Title");
		expect(h.conversations.get("c1")?.titleSource).toBe("model");
		expect(h.outcomes()).toEqual([
			{ model: "free-model", ok: true, reason: "titled" },
		]);
	});

	test("a second send does not re-title", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
		});

		h.emit(SIGNAL);
		await settle();
		expect(h.requests()).toBe(1);

		// The store after the first turn: two messages and a model title.
		h.setConversation("c1", {
			messages: [{}, {}],
			titleSource: "model",
		});
		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(1);
	});

	test("a hydrated conversation with messages is never titled", async () => {
		// An old conversation on its next send: several messages, no source yet.
		const h = await makeHarness({
			conversations: [["c1", { messages: [{}, {}, {}, {}] }]],
		});

		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(0);
		expect(h.writes()).toEqual([]);
	});

	test("a rename wins: a title that lands while one is in flight is not overwritten", async () => {
		const held = Effect.runSync(Deferred.make<string | undefined>());
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			titleFor: () => Effect.map(Deferred.await(held), () => "A Model Title"),
		});

		h.emit(SIGNAL);
		await settle();
		expect(h.requests()).toBe(1);

		// The rename lands while the request is in flight...
		h.setConversation("c1", { messages: firstMessage(), titleSource: "user" });
		h.titles.set("c1", "My Own Title");

		// ...and the title that arrives afterwards must not replace it.
		Effect.runSync(Deferred.succeed(held, "A Model Title"));
		await settle();

		expect(h.titles.get("c1")).toBe("My Own Title");
		expect(h.writes()).toEqual([]);
		// The fibre did resume and finish — the refusal, not a dead run.
		expect(h.outcomes().at(-1)).toEqual({
			model: "free-model",
			ok: true,
			reason: "the conversation was renamed or deleted first",
		});
	});

	test("a conversation the user renamed is never titled", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: [], titleSource: "user" }]],
		});

		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(0);
	});

	test("a failed title leaves the derived title and logs, and the turn survives", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			titleFor: () => Effect.fail("the endpoint refused the request"),
		});

		const logged = spyOn(console, "log");
		// The failure happens on the forked fibre: emitting must not throw.
		h.emit(SIGNAL);
		await settle();
		const calls = logged.mock.calls.length;
		logged.mockRestore();

		expect(h.writes()).toEqual([]);
		expect(h.outcomes().at(-1)).toEqual({
			model: "free-model",
			ok: false,
			reason: "the endpoint refused the request",
		});
		expect(calls).toBeGreaterThan(0);
	});

	test("a protocol whose send throws synchronously is a recorded failure, not a silent no-op", async () => {
		// `titleFor` declares a typed failure, but a `send` that throws defects
		// the effect instead — the chat path isolates that in `sendThrough`,
		// `titleFor` does not. The defect must still be logged and recorded.
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			titleFor: () => {
				throw new Error("send threw before returning a stream");
			},
		});

		const logged = spyOn(console, "log");
		h.emit(SIGNAL);
		await settle();
		const calls = logged.mock.calls.length;
		logged.mockRestore();

		expect(h.requests()).toBe(1);
		expect(h.writes()).toEqual([]);
		expect(h.outcomes().at(-1)?.ok).toBe(false);
		expect(h.outcomes().at(-1)?.reason).toContain("send threw");
		expect(calls).toBeGreaterThan(0);
	});

	test("with no model resolved, no request is made at all", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			resolve: () => undefined,
		});

		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(0);
		// An honest no-op is not an attempt: nothing to explain in the hint.
		expect(h.outcomes()).toEqual([]);
	});

	test("an attachments-only first message (empty text) is skipped", async () => {
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
		});

		h.emit({ conversationId: "c1", text: "" });
		await settle();

		expect(h.requests()).toBe(0);
	});

	test("a conversation deleted while a title is in flight writes nothing", async () => {
		const held = Effect.runSync(Deferred.make<string | undefined>());
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			titleFor: () => Effect.map(Deferred.await(held), () => "A Model Title"),
		});

		h.emit(SIGNAL);
		await settle();
		expect(h.requests()).toBe(1);

		h.conversations.delete("c1");
		Effect.runSync(Deferred.succeed(held, "A Model Title"));
		await settle();

		expect(h.writes()).toEqual([]);
		// The fibre resumed: the refusal is recorded, not a silent dead run.
		expect(h.outcomes().at(-1)).toEqual({
			model: "free-model",
			ok: true,
			reason: "the conversation was renamed or deleted first",
		});
	});

	test("the area closes its run when toggled off", async () => {
		const held = Effect.runSync(Deferred.make<string | undefined>());
		const h = await makeHarness({
			conversations: [["c1", { messages: firstMessage() }]],
			titleFor: () => Effect.map(Deferred.await(held), () => "A Model Title"),
		});

		h.emit(SIGNAL);
		await settle();
		expect(h.requests()).toBe(1);
		expect(h.subscriptions()).toBe(1);

		// Toggling the area off is a close of its scope: it releases the
		// subscription and interrupts the title in flight.
		await h.close();
		expect(h.subscriptions()).toBe(0);

		// The fibre is interrupted, not merely unobserved: had it survived,
		// finishing the held request would have written the title.
		Effect.runSync(Deferred.succeed(held, "A Model Title"));
		await settle();
		expect(h.writes()).toEqual([]);

		// And a later signal cannot reach a released subscription.
		h.emit(SIGNAL);
		await settle();
		expect(h.requests()).toBe(1);
	});

	test("with the area off the registrar never runs, so no subscription is installed", async () => {
		const h = makeDeps({
			conversations: [["c1", { messages: firstMessage() }]],
		});
		const s = services();
		// The real area table, with every registrar stubbed out except this
		// area's — which is the one under observation.
		const areas = BUILTIN_AREAS.map((area) => ({
			...area,
			register:
				area.id === "app.titler"
					? (host: Host): void => registerTitlerBuiltins(host, h.deps)
					: (): void => {},
		}));
		const makeReconciler = (titlerOn: boolean) =>
			makeBuiltinsReconciler({
				areas,
				enabledOf: (areaId) => areaId !== "app.titler" || titlerOn,
				contributionEnabledOf: () => true,
				makeHost,
			});

		const off = makeReconciler(false);
		await Effect.runPromise(off.reconcile(s));
		await settle();
		h.emit(SIGNAL);
		await settle();

		expect(h.subscriptions()).toBe(0);
		expect(h.requests()).toBe(0);

		// The positive control: the same wiring with the area on does reach it,
		// so the zero above is the gate and not a counter that never moves.
		const on = makeReconciler(true);
		await Effect.runPromise(on.reconcile(s));
		await settle();
		h.emit(SIGNAL);
		await settle();

		expect(h.requests()).toBe(1);
	});
});

describe("the app.titler identity", () => {
	test("is one toggleable area with a registrar, in the table", () => {
		const area = BUILTIN_AREAS.find(
			(candidate) => candidate.id === "app.titler",
		);
		expect(area).toBeDefined();
		expect(area?.locked).not.toBe(true);
		expect(typeof area?.register).toBe("function");
	});
});
