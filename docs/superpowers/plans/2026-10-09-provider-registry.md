# Provider Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the protocol string-switch with a registry of per-protocol provider objects, where `ProtocolName` is derived from the registry keys.

**Architecture:** Each protocol is a module exporting an object `satisfies Provider<Send>` that owns its schema, parse, template, endpoint, request builder and HTTP+stream `send`. `providers/index.ts` collects them `as const` and derives `ProtocolName = keyof typeof providers`. `api/index.ts`'s `SendMsg` becomes a single registry lookup with no branching.

**Tech Stack:** TypeScript, Effect 4, zod 4, `bun test`, Biome + `@effect/language-service`.

**Spec:** `docs/superpowers/specs/2026-10-09-provider-registry-design.md`

## Global Constraints

- No new dependencies (Effect + zod only).
- Effect for all functions; zod for validation.
- Registry key **is** the protocol wire string (`chatcompletions`, lowercase) — preserves today's `"responses" | "chatcompletions"`.
- `bun run lint` (Biome + effect LS) stays green.
- Test runner is `bun test`; test files are exempt from the Effect-style Grit plugins (they legitimately use `async`/`await`).

## Review Focus

Inputs/failure modes the spec implies but no task's happy-path test covers — each gets a test in the owning task:

1. **First turn** — `ctx.prev` is `undefined`/absent; the provider must fall back to its `template`, not throw. (Task 1)
2. **Unknown protocol at runtime** — a `protocol` value not in the registry (via an unchecked cast) → `SendMsg` must fail cleanly, not `TypeError` on `undefined.send`. (Task 1)
3. **Non-JSON / error response body** — `send` fails with a `string`, never an unhandled defect. (Task 3)
4. **Missing `apiKey`** — request is built without an auth header, predictably. (Task 3)
5. **Stream sentinel / non-text event** — the SSE `[DONE]`/finish event must not surface as an empty `Chunk`. (Task 3)

---

### Task 1: Registry spine (contract + both providers + registry + `SendMsg`)

**Files:**
- Create: `web/src/lib/providers/types.ts`
- Create: `web/src/lib/providers/responses.ts`
- Create: `web/src/lib/providers/chatCompletions.ts`
- Create: `web/src/lib/providers/index.ts`
- Test: `web/src/lib/providers/index.test.ts`
- Modify: `web/src/lib/api/index.ts` (rewrite to a single lookup)
- Modify: `web/src/lib/types/protocols.ts` (remove the `ProtocolName` enum)
- Delete: `web/src/lib/util/exhaustiveCheck.ts`
- Modify: `web/package.json` (add `"test": "bun test"`)
- Modify: `biome.jsonc` (exempt `**/*.test.ts` from each plugin)

**Interfaces:**
- Consumes: `ResponsesSend` / `ChatCompletionsSend` (const + inferred type, `@lib/types/protocols`), `parseResponsesSend` / `parseChatCompletionsSend` (`@lib/core/parse`), `responsesSendMinTemplate` (`@lib/util/templates`).
- Produces:
  - `Chunk = { readonly text: string }`, `SendCtx = { msg: string; prev: unknown; apiUrl: string; apiKey?: string }`
  - `Provider<Send>` interface (see file below)
  - `providers`, `ProtocolName`, `protocolNames` (`@lib/providers`)
  - `SendMsg(protocol: ProtocolName, ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string>`

- [ ] **Step 1: Test harness + plugin exemption**

Add to `web/package.json` scripts: `"test": "bun test"`. In `biome.jsonc`, append `"!**/*.test.ts"` to every plugin's `includes` array (so tests may use `async`/`await`).

- [ ] **Step 2: Write the failing test** — `web/src/lib/providers/index.test.ts`

```ts
import { Effect, Stream } from "effect";
import { describe, expect, test } from "bun:test";
import { SendMsg, protocolNames, providers } from "@lib/providers";
import type { SendCtx } from "@lib/providers/types";

const ctx: SendCtx = { msg: "hi", prev: undefined, apiUrl: "http://x" };

describe("registry", () => {
	test("exposes both protocols", () => {
		expect(protocolNames).toEqual(["responses", "chatcompletions"]);
	});

	test("SendMsg returns the provider's effect for each protocol", () => {
		for (const p of protocolNames) {
			expect(Effect.isEffect(SendMsg(p, ctx))).toBe(true);
		}
	});

	test("accepts an absent prev (first turn)", () => {
		expect(providers.responses.parse(providers.responses.template)._tag).toBe("Success");
	});
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd web && bun test src/lib/providers/index.test.ts`
Expected: FAIL — cannot resolve `@lib/providers`.

- [ ] **Step 4: Write the contract** — `web/src/lib/providers/types.ts`

```ts
import type { Effect, Stream } from "effect";
import type { z } from "zod";

export interface Chunk {
	readonly text: string;
}

export interface SendCtx {
	readonly msg: string;
	readonly prev: unknown;
	readonly apiUrl: string;
	readonly apiKey?: string;
}

export interface Provider<Send> {
	readonly schema: z.ZodType<Send>;
	readonly endpoint: string;
	readonly template: Send;
	parse(raw: unknown): Effect.Effect<Send, string>;
	buildRequest(send: Send, ctx: SendCtx): unknown;
	send(ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string>;
}
```

If TS rejects `z.ZodType<Send>` on variance, widen to `z.ZodType<Send, z.ZodTypeDef, unknown>`.

- [ ] **Step 5: Write the `responses` provider** — `web/src/lib/providers/responses.ts`

```ts
import { Effect, Stream } from "effect";
import { parseResponsesSend } from "@lib/core/parse";
import type { Chunk, Provider, SendCtx } from "@lib/providers/types";
import { ResponsesSend } from "@lib/types/protocols";
import { responsesSendMinTemplate } from "@lib/util/templates";

export const responses = {
	schema: ResponsesSend,
	endpoint: "/v1/responses",
	template: responsesSendMinTemplate,
	parse: parseResponsesSend,
	buildRequest: (send: ResponsesSend, _ctx: SendCtx) => send,
	send: (_ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string> =>
		Effect.succeed(Stream.empty),
} satisfies Provider<ResponsesSend>;
```

- [ ] **Step 6: Write the `chatcompletions` provider** — `web/src/lib/providers/chatCompletions.ts`

Same shape as Step 5, but:
- `schema: ChatCompletionsSend`, `endpoint: "/v1/chat/completions"`, `template: { model: "" }`, `parse: parseChatCompletionsSend`.
- Exported const name is `chatcompletions` (lowercase) so the registry key equals the wire string.

- [ ] **Step 7: Write the registry** — `web/src/lib/providers/index.ts`

```ts
import { chatcompletions } from "@lib/providers/chatCompletions";
import { responses } from "@lib/providers/responses";

export const providers = { responses, chatcompletions } as const;
export type ProtocolName = keyof typeof providers;
export const protocolNames = Object.keys(providers) as ProtocolName[];
```

(`protocolSchema` from the spec is dropped — nothing needs a runtime enum yet, and `z.enum` wants a tuple. YAGNI.)

- [ ] **Step 8: Rewrite the call site** — `web/src/lib/api/index.ts` (replace the whole file)

```ts
import { providers, type ProtocolName } from "@lib/providers";
import type { Chunk, SendCtx } from "@lib/providers/types";
import type { Effect, Stream } from "effect";

export const SendMsg = (
	protocol: ProtocolName,
	ctx: SendCtx,
): Effect.Effect<Stream.Stream<Chunk>, string> => providers[protocol].send(ctx);
```

- [ ] **Step 9: Remove the old type + dead helper**

Delete the `ProtocolName` export from `web/src/lib/types/protocols.ts`. Delete `web/src/lib/util/exhaustiveCheck.ts`. (`core/parse.ts` and `util/templates.ts` stay — the providers reference them.)

- [ ] **Step 10: Run the test → pass, then typecheck**

Run: `cd web && bun test src/lib/providers/index.test.ts && bunx tsc --noEmit -p tsconfig.app.json`
Expected: tests PASS; tsc reports no error in `src/lib/providers/**` or `src/lib/api/**`.

- [ ] **Step 11: Commit**

```bash
git add web/src/lib/providers web/src/lib/api/index.ts web/src/lib/types/protocols.ts web/package.json biome.jsonc
git rm web/src/lib/util/exhaustiveCheck.ts
git commit -m "feat(lib): provider registry keyed by protocol (replace string-switch)"
```

---

### Task 2: Real `buildRequest` per provider

**Files:**
- Modify: `web/src/lib/providers/responses.ts`
- Modify: `web/src/lib/providers/chatCompletions.ts`
- Test: `web/src/lib/providers/buildRequest.test.ts`

**Interfaces:**
- Consumes: `providers` (Task 1), `SendCtx`, `Chunk`.
- Produces: each provider's `buildRequest(send, ctx) => unknown` now returns the wire body with the user turn appended.

- [ ] **Step 1: Write the failing test** — `web/src/lib/providers/buildRequest.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { providers } from "@lib/providers";
import type { SendCtx } from "@lib/providers/types";

const ctx = (msg: string): SendCtx => ({ msg, prev: undefined, apiUrl: "http://x" });

test("responses body appends a user input_text turn", () => {
	const body = providers.responses.buildRequest(providers.responses.template, ctx("hello")) as {
		model: string;
		input: { role: string; content: { type: string; text: string }[] }[];
		stream: boolean;
	};
	expect(body.model).toBe("");
	expect(body.stream).toBe(true);
	expect(body.input.at(-1)).toEqual({
		role: "user",
		content: [{ type: "input_text", text: "hello" }],
	});
});

test("chatcompletions body appends a user message", () => {
	const body = providers.chatcompletions.buildRequest(providers.chatcompletions.template, ctx("hello")) as {
		model: string;
		messages: { role: string; content: string }[];
	};
	expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && bun test src/lib/providers/buildRequest.test.ts`
Expected: FAIL — current `buildRequest` returns the send unchanged (no appended turn).

- [ ] **Step 3: Implement `responses.buildRequest`**

Return `{ ...send, input: [...normalize(send.input), { role: "user", content: [{ type: "input_text", text: ctx.msg }] }] }`, where `normalize` turns a `string` `input` into `[{ role: "user", content: [{ type: "input_text", text }] }]` and an array passes through. Keep it a pure function — no Effect.

- [ ] **Step 4: Implement `chatcompletions.buildRequest`**

Return `{ ...send, messages: [...(send as { messages?: unknown[] }).messages ?? [], { role: "user", content: ctx.msg }] }`. (The `ChatCompletionsSend` schema is still minimal; the appended `messages` array is not re-validated.)

- [ ] **Step 5: Run the test → pass, then typecheck**

Run: `cd web && bun test src/lib/providers/buildRequest.test.ts && bunx tsc --noEmit -p tsconfig.app.json`
Expected: PASS; no new tsc errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/providers
git commit -m "feat(lib): real buildRequest per provider"
```

---

### Task 3: Real `send` (HTTP + stream)

**Files:**
- Modify: `web/src/lib/providers/responses.ts`
- Modify: `web/src/lib/providers/chatCompletions.ts`
- Test: `web/src/lib/providers/send.test.ts`

**Interfaces:**
- Consumes: providers (Task 1/2), `SendCtx`, `Chunk`, `Provider.buildRequest`.
- Produces: `send(ctx): Effect.Effect<Stream.Stream<Chunk>, string>` doing the real `fetch` and mapping the SSE body to `Chunk`s.

- [ ] **Step 1: Write the failing test** — `web/src/lib/providers/send.test.ts`

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { Chunk, Effect, Stream } from "effect";
import { providers } from "@lib/providers";
import type { SendCtx } from "@lib/providers/types";

const ctx = (over: Partial<SendCtx> = {}): SendCtx => ({
	msg: "hi",
	prev: undefined,
	apiUrl: "http://test",
	...over,
});

const enableFetch = (impl: typeof fetch) => { globalThis.fetch = impl; };
afterEach(() => { /* restore */ });

// helper: collect a Chunk stream to string[]
const collect = (s: Stream.Stream<Chunk>) => Stream.runCollect(s).pipe(
	Effect.map((c) => Chunk.isChunkList ? [] : Array.from(c).map((x) => x.text)),
	Effect.runPromise,
);

test("maps SSE data lines to text chunks, skipping [DONE] and blanks", async () => {
	enableFetch(async () => new Response(
		'data: {"delta":"a"}\n\ndata: [DONE]\n\n',
		{ status: 200 },
	));
	expect(await collect(await Effect.runPromise(providers.responses.send(ctx())))).toEqual(["a"]);
});

test("fails with a string on a non-2xx response", async () => {
	enableFetch(async () => new Response("nope", { status: 500 }));
	await expect(Effect.runPromise(providers.responses.send(ctx()))).rejects.toThrow();
});

test("builds a request without an auth header when apiKey is absent", async () => {
	let seen: Headers | undefined;
	enableFetch(async (_u, init) => { seen = new Headers(init?.headers); return new Response("data: [DONE]\n\n"); });
	await Effect.runPromise(providers.responses.send(ctx()));
	expect(seen?.has("authorization")).toBe(false);
});
```

Fix the `collect` helper to the actual Effect 4 `Stream`/`Chunk` API at implementation time; its job is only to turn the stream into `string[]`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && bun test src/lib/providers/send.test.ts`
Expected: FAIL — `send` still returns `Stream.empty`.

- [ ] **Step 3: Implement a shared `send` helper** — `web/src/lib/providers/send.ts`

```ts
export const sendStream = (
	url: string,
	apiKey: string | undefined,
	body: unknown,
): Effect.Effect<Stream.Stream<Chunk>, string> => /* see steps */
```
Behavior: `Effect.tryPromise({ try: () => fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal }), catch: (e) => String(e) })`; on a non-`ok` response, `Effect.fail(\`HTTP ${status}: ${await text}\`)`; else map `response.body` through `Stream.fromReadableStream` + a line decoder, parse each `data:` line as JSON, skip `[DONE]` and empty lines, and emit `{ text: delta }`. No `async`/`await`, no `new Promise` — the plugins forbid them; use `yield*`.

- [ ] **Step 4: Wire each provider's `send`** to `sendStream`. URL = `ctx.apiUrl + provider.endpoint`; body = `buildRequest(templateOrPrev, ctx)` (fall back to `template` when `ctx.prev` is absent — Review Focus #1); header `authorization: Bearer ${ctx.apiKey}` only when `apiKey` is set (Review Focus #4).

- [ ] **Step 5: Run the tests → pass**

Run: `cd web && bun test src/lib/providers/send.test.ts`
Expected: PASS — all three cases, plus the sentinel case from Review Focus #5.

- [ ] **Step 6: Full gates**

Run: `cd web && bun test && bunx tsc --noEmit -p tsconfig.app.json`
Run from repo root: `biome check .`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/providers
git commit -m "feat(lib): real HTTP + streaming send per provider"
```

---

## Self-Review

- **Spec coverage:** §1 contract → Task 1 Step 4; §2 provider objects → Steps 5–6; §3 registry → Step 7; §4 call site → Step 8; §5 disposition → Step 9. Decisions: Chunk (Step 4), error=string (Steps 4/5), raw-fetch HTTP (Task 3), ownership (Steps 5–6). All covered.
- **Placeholder scan:** the two "implement at implementation time" notes (ZodType variance, the `collect` helper) are deliberate — both are one-line shims whose exact API depends on the installed Effect/zod version, and both have an explicit target (`Effect<Stream<Chunk>>`, `string[]`).
- **Type consistency:** `Chunk`, `SendCtx`, `Provider`, `providerNames`, `ProtocolName`, `SendMsg` are defined once and referenced with the same names in later tasks.
- **Proportion:** tasks describe signatures + test assertions; bodies are left to the implementer except the two shims.
