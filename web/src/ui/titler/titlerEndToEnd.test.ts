import { describe, expect, test } from "bun:test";
import { emptyProviderConfig } from "@lib/db";
import { BUILTIN_AREAS } from "@lib/plugins/areas";
import { makeBuiltinsReconciler } from "@lib/plugins/builtin";
import { registerTitlerBuiltins } from "@lib/plugins/builtin/titler";
import {
	HostLayer,
	HostServices,
	type HostServicesShape,
	makeHost,
} from "@lib/plugins/host";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import { runtime } from "@lib/plugins/runtime";
import { subscribeHostEvent } from "@lib/plugins/services";
import { chatcompletions } from "@lib/providers/chatCompletions";
import type { Chunk, SendCtx } from "@lib/providers/types";
import { resolveTitlerModel, TITLER_PROMPT } from "@lib/titler";
import { getTitlerOutcome } from "@lib/titlerStatus";
import { Effect, Exit, Scope, Stream } from "effect";
import {
	getChat,
	newConversation,
	renameConversation,
	send,
} from "@/state/chat";
import { getSettings, setSettings } from "@/state/settings";
import { titlerRows } from "@/ui/titler/titlerRows";

/**
 * T5's end-to-end: a **scripted turn** through every real component of the
 * feature — `state/chat.ts`'s `send`, its `subscribeUserMessage` signal, the
 * real `app.titler` area (`registerTitlerBuiltins`, real deps), `lib/titler.ts`'s
 * `titleFor`, and `state/chat.ts`'s `titleIfDerived` against the real store.
 * **Only the network is faked**: the provider's `send` answers from a value
 * instead of an HTTP stream, and it is registered in the app's own providers
 * registry, exactly as a plugin's protocol is.
 *
 * What this file adds over `builtin/titler.test.ts` (which injects every
 * collaborator) is the wiring between them: the store's real signal reaching the
 * real subscriber, the real model rule resolving the real settings, and the
 * real write landing on the real conversation. It does **not** re-test the
 * trigger's cases — those are injected, and counted, in the area's own suite.
 *
 * ## The provider id and the protocol are different fields
 *
 * `Settings.providers[].id` is the app's own identity — `state/settings.ts`
 * `addProvider` mints `provider-<uuid>` — while the wire protocol is a separate
 * `protocol` field, a name a plugin registers. `resolveTitlerModel` returns the
 * **provider id**, so the area must find the config by that id and hand
 * `config.protocol` (never the id) to `resolveProviderSync`. Getting it wrong is
 * silent: `resolveTarget` then returns `undefined` for every real user while the
 * hint still claims a model, so the titler is an honest no-op. T4 shipped that
 * mismatch and T5's review measured it; this fixture keeps the **uuid-shaped id
 * plus a distinct protocol** — the shape the app actually stores — so the chain
 * cannot pass again on an aligned pair that no user can produce.
 */

/** The registered protocol name the fake provider answers to. */
const PROTOCOL = "t5-titler-openrouter";

/** The app's own uuid-shaped provider identity — never a protocol name. */
const PROVIDER_ID = "provider-fixture-0a1b2c3d";

/** The free id the rule picks out of the seeded provider's own cached list. */
const FREE_ID = "openrouter/free";

/** A decorated reply, so the real sanitizer runs on the way to the store. */
const MODEL_REPLY = '**Title:** "Bread Making Basics"';
/** What `cleanTitle` makes of {@link MODEL_REPLY}. */
const CLEAN_TITLE = "Bread Making Basics";

const FIRST_MESSAGE = "How do I bake bread?";

const services = (): HostServicesShape =>
	Effect.runSync(HostServices.pipe(Effect.provide(HostLayer)));

/** Let a forked fibre's continuations run (the suite-wide `tick` shape). */
const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

const settle = async (): Promise<void> => {
	for (let spins = 0; spins < 20; spins += 1) await tick();
};

interface Fake {
	readonly provider: unknown;
	/** One entry per titler request: the message it carried and the body built. */
	readonly titlerRequests: readonly {
		readonly msg: string;
		readonly body: unknown;
	}[];
	readonly chatRequests: number;
}

/**
 * The real `chatcompletions` protocol with the one line that reaches the wire
 * kept and the stream answered from a value: the chat turn and the titler both
 * go through this, told apart by the request's own message (the titler's carries
 * {@link TITLER_PROMPT}).
 */
const makeFake = (
	options: { readonly fail?: string; readonly reply?: string } = {},
): Fake => {
	const titlerRequests: { msg: string; body: unknown }[] = [];
	let chatRequests = 0;
	return {
		titlerRequests,
		get chatRequests(): number {
			return chatRequests;
		},
		provider: {
			...chatcompletions,
			send: (
				ctx: SendCtx,
			): Effect.Effect<Stream.Stream<Chunk, string>, string> => {
				const body = chatcompletions.buildRequest(
					(ctx.prev ?? chatcompletions.template) as never,
					ctx,
				);
				if (ctx.msg.startsWith(TITLER_PROMPT)) {
					titlerRequests.push({ msg: ctx.msg, body });
					if (options.fail !== undefined) return Effect.fail(options.fail);
					return Effect.succeed(
						Stream.make({
							kind: "text",
							text: options.reply ?? MODEL_REPLY,
						} as Chunk),
					);
				}
				chatRequests += 1;
				return Effect.succeed(
					Stream.make({ kind: "text", text: "Sure — here is how." } as Chunk),
				);
			},
		},
	};
};

/** Register the fake in the app's own providers registry, as a plugin would. */
const addProvider = (protocol: string, provider: unknown): Disposable =>
	runtime.runSync(
		Effect.flatMap(HostServices, (host) =>
			host.providers.add({
				id: protocol,
				owner: "t5-e2e",
				...(provider as Record<string, unknown>),
			} as unknown as RegistryEntry),
		),
	);

/**
 * The settings a real OpenRouter user would have: a provider with a key and a
 * cached model list that carries the free id. Returns the restore.
 */
const seedSettings = (): (() => void) => {
	const before = getSettings();
	setSettings({
		providers: [
			{
				...emptyProviderConfig(PROVIDER_ID),
				label: "OpenRouter (fake)",
				protocol: PROTOCOL,
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "fixture-key-not-real",
				model: FREE_ID,
				models: [FREE_ID],
			},
		],
		activeProviderId: PROVIDER_ID,
	});
	return () => {
		setSettings({
			providers: before.providers,
			activeProviderId: before.activeProviderId,
		});
	};
};

/** The area registered on a scope the test owns, closed at the end. */
const startArea = (): { readonly close: () => Promise<void> } => {
	const scope = Effect.runSync(Scope.make());
	registerTitlerBuiltins(makeHost(services(), "app.titler", scope));
	return { close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

/** One real turn: the send, then its own completion signal, then a settle. */
const turn = async (msg: string): Promise<void> => {
	const done = new Promise<void>((resolve) => {
		const subscription = subscribeHostEvent("turn-end", () => {
			subscription.dispose();
			resolve();
		});
	});
	send(msg, []);
	await done;
	// The titler's run is forked from the signal's handler, so it finishes just
	// after the turn does.
	await settle();
};

/** A fresh conversation, its id, and the store's row for it. */
const freshConversation = (): string => {
	newConversation();
	return getChat().activeId;
};

const conversation = (id: string) =>
	getChat().conversations.find((candidate) => candidate.id === id);

describe("a scripted turn titles the conversation", () => {
	test("the first message reaches the fake provider and the real store gets the title", async () => {
		const fake = makeFake();
		const providerHandle = addProvider(PROTOCOL, fake.provider);
		const restore = seedSettings();
		const area = startArea();
		await settle();
		const id = freshConversation();

		try {
			await turn(FIRST_MESSAGE);

			// Exactly one titler request, and it is the titler's own: the
			// conversation's first message, carrying the prompt.
			expect(fake.titlerRequests).toHaveLength(1);
			const request = fake.titlerRequests[0];
			expect(request?.msg).toContain(TITLER_PROMPT);
			expect(request?.msg).toContain(FIRST_MESSAGE);

			// The outgoing body is the real builder's: no tools (a title needs
			// no round trip) and the free id the rule resolved.
			const body = request?.body as {
				readonly model?: unknown;
				readonly tools?: unknown;
			};
			expect(body.model).toBe(FREE_ID);
			expect(body.tools).toBeUndefined();

			// The real write, on the real conversation: sanitized, and marked as
			// the model's so a second attempt is refused.
			expect(conversation(id)?.title).toBe(CLEAN_TITLE);
			expect(conversation(id)?.titleSource).toBe("model");

			// And the attempt is what the settings hint reads.
			expect(getTitlerOutcome()).toEqual({
				model: FREE_ID,
				ok: true,
				reason: "titled",
			});
		} finally {
			await area.close();
			restore();
			providerHandle.dispose();
		}
	});

	test("a failing title leaves the derived title, records the reason, and the hint says so", async () => {
		const fake = makeFake({ fail: "the endpoint refused the request" });
		const providerHandle = addProvider(PROTOCOL, fake.provider);
		const restore = seedSettings();
		const area = startArea();
		await settle();
		const id = freshConversation();

		try {
			await turn(FIRST_MESSAGE);

			expect(fake.titlerRequests).toHaveLength(1);
			// The derived title stands — `deriveTitle`'s own text — and nothing
			// claims the name, so a later attempt is still allowed.
			expect(conversation(id)?.title).toBe(FIRST_MESSAGE);
			expect(conversation(id)?.titleSource).toBeUndefined();

			// The reason reaches the record the row reads...
			expect(getTitlerOutcome()).toEqual({
				model: FREE_ID,
				ok: false,
				reason: "the endpoint refused the request",
			});
			// ...and the rows turn a real failure into the failed hint, with the
			// reason and the guarantee, not into the "nothing resolves" one.
			const settings = getSettings();
			const rows = titlerRows({
				resolved: resolveTitlerModel(settings, false),
				providers: settings.providers,
				selection: settings.titler,
				status: getTitlerOutcome(),
			});
			expect(rows.state).toBe("failed");
			expect(rows.hint).toContain("the endpoint refused the request");
			expect(rows.hint).toContain("A rename is never overwritten.");
		} finally {
			await area.close();
			restore();
			providerHandle.dispose();
		}
	});

	test("a renamed conversation is never titled by a later send", async () => {
		const fake = makeFake();
		const providerHandle = addProvider(PROTOCOL, fake.provider);
		const restore = seedSettings();
		const area = startArea();
		await settle();
		const id = freshConversation();
		renameConversation(id, "My Own Title");

		try {
			await turn(FIRST_MESSAGE);

			// No request at all: the trigger's second half refuses a title a
			// human owns, and the fetch log — not the sidebar — is the evidence.
			expect(fake.titlerRequests).toHaveLength(0);
			expect(conversation(id)?.title).toBe("My Own Title");
			expect(conversation(id)?.titleSource).toBe("user");
		} finally {
			await area.close();
			restore();
			providerHandle.dispose();
		}
	});
});

describe("the area's own gate, end to end", () => {
	test("with the area off no request is made; with it on the same turn is titled", async () => {
		const fake = makeFake();
		const providerHandle = addProvider(PROTOCOL, fake.provider);
		const restore = seedSettings();
		const service = services();
		let titlerOn = false;
		const reconciler = makeBuiltinsReconciler({
			areas: BUILTIN_AREAS,
			enabledOf: (areaId) => (areaId === "app.titler" ? titlerOn : true),
			contributionEnabledOf: () => true,
			makeHost,
		});

		try {
			// The real reconciler, the real area table: with `app.titler` off the
			// registrar never runs, so there is no subscriber to hear the signal.
			await Effect.runPromise(reconciler.reconcile(service));
			await settle();
			const offId = freshConversation();
			await turn(FIRST_MESSAGE);

			expect(fake.titlerRequests).toHaveLength(0);
			// The turn itself is unaffected: the derived title is there.
			expect(conversation(offId)?.title).toBe(FIRST_MESSAGE);

			// The positive control, so the zero above is the gate and not a
			// counter that never moves: the same wiring, area on.
			titlerOn = true;
			await Effect.runPromise(reconciler.reconcile(service));
			await settle();
			const onId = freshConversation();
			await turn(FIRST_MESSAGE);

			expect(fake.titlerRequests).toHaveLength(1);
			expect(conversation(onId)?.title).toBe(CLEAN_TITLE);
			expect(conversation(onId)?.titleSource).toBe("model");
		} finally {
			// Close the scopes this reconcile opened (its titler subscription
			// included), so nothing live outlives the test.
			titlerOn = false;
			await Effect.runPromise(reconciler.reconcile(service));
			restore();
			providerHandle.dispose();
		}
	});
});
