# Provider Registry — Design

Status: approved in chat, awaiting spec review
Date: 2026-10-09

## Intent

Replace the string-switch in `src/lib/api/index.ts` and the duplicated per-protocol
parsers with a **registry of provider objects**, one per protocol. Each object owns
everything protocol-specific: its zod schema, its `parse`, its default template, its
endpoint, its request builder, and its HTTP + streaming call.

The registry is the **source of truth**: `ProtocolName` is derived from its keys, so
adding a provider is one object and nothing else, and a protocol cannot exist without a
complete provider (enforced by `satisfies`).

Goal: **extensible AND exhaustive** — add providers without touching the send path, and
make an incomplete/omitted provider a compile error.

## Constraints

- No new dependencies (Effect, zod already present).
- Effect for all functions; zod for validation.
- Biome + `@effect/language-service` gates stay green.
- The call site stays protocol-agnostic.

## Vocabulary

- **Protocol / provider** — `"responses" | "chatcompletions"` (current `ProtocolName` axis; **not** vendors).
- **Send** — the validated request/thread body for a protocol (`ResponsesSend` | `ChatCompletionsSend`).
- **Chunk** — one streamed piece of the assistant reply.
- **SendCtx** — the per-turn context: message, prior thread, api url, api key.

## Design

### 1. Contract — `src/lib/providers/types.ts`

```ts
import type { Effect, Stream } from "effect";
import type { z } from "zod";

export interface Chunk {
	readonly text: string;
}

export interface SendCtx {
	readonly msg: string;
	readonly prev: unknown; // prior thread; the provider validates it
	readonly apiUrl: string;
	readonly apiKey?: string;
}

export interface Provider<Send> {
	readonly schema: z.ZodType<Send>;
	readonly template: Send;
	readonly endpoint: string; // e.g. "/v1/responses"
	parse(raw: unknown): Effect.Effect<Send, string>;
	buildRequest(send: Send, ctx: SendCtx): unknown;
	send(ctx: SendCtx): Effect.Effect<Stream.Stream<Chunk>, string>;
}
```

`send`'s signature never mentions `Send`, so every provider's `send` has an identical
type — that is what lets `providers[name].send(ctx)` type-check across the registry union.

### 2. One object per provider — `src/lib/providers/responses.ts`, `chatCompletions.ts`

```ts
export const responses = {
	schema: ResponsesSend,
	template: responsesSendMinTemplate,
	endpoint: "/v1/responses",
	parse: parseResponsesSend,
	buildRequest: (send, ctx) => /* msg + prev -> request body */,
	send: (ctx) => Effect.gen(function* () { /* HTTP + stream -> Stream<Chunk> */ }),
} satisfies Provider<ResponsesSend>;
```

`satisfies Provider<Send>` makes a missing or wrong field a compile error, per object.

### 3. Registry — `src/lib/providers/index.ts`

```ts
export const providers = { responses, chatcompletions } as const;
export type ProtocolName = keyof typeof providers; // derived — no union to maintain
export const protocolNames = Object.keys(providers) as ProtocolName[];
export const protocolSchema = z.enum(protocolNames); // only if a runtime enum is wanted
```

The registry key **is** the protocol string, so keys must match the wire value exactly
(`chatcompletions`, not `chatCompletions`) — this preserves the current
`"responses" | "chatcompletions"` values. The module file / local identifier spelling is
free (`chatCompletions.ts` exporting `chatcompletions`).

### 4. Call site — `src/lib/api/index.ts`

```ts
export const SendMsg = (protocol: ProtocolName, ctx: SendCtx) =>
	providers[protocol].send(ctx);
```

No string-switch, no `assert`, no silent default-template fallback. A bad protocol is a
compile error at the call site.

### 5. Disposition of existing code

- `src/lib/core/parse.ts` — `parseResponsesSend` / `parseChatCompletionsSend` become each
  provider's `parse` (live in the provider modules, or stay put and be referenced; final
  placement is an implementation detail).
- `src/lib/util/exhaustiveCheck.ts` (`assert`) — **deleted**; exhaustiveness is structural.
- `src/lib/util/templates.ts` (`responsesSendMinTemplate`) — folds into the `responses` provider.
- `ProtocolName` in `src/lib/types/protocols.ts` — removed; replaced by the derived type.

## Decisions

- **Chunk** = `{ readonly text: string }`. Minimal; a `type` discriminator is deferred
  until tool calls / non-text parts actually need it (YAGNI).
- **Error channel** stays `string` for this pass, matching today's `Effect<_, string>`.
  Tagged (`Data.TaggedError`) errors are a follow-up once recovery needs tags.
- **HTTP** via raw `fetch` wrapped in `Effect.tryPromise`, response body via
  `Stream.fromReadableStream` — no new dependency. `@effect/platform` `HttpClient` is the
  documented upgrade path. If the effect language service flags `globalFetch` inside
  provider files, scope that diagnostic to the provider directory rather than disable it
  globally.
- **Ownership**: `schema`, `parse`, `template`, `endpoint`, `buildRequest`, `send` (HTTP +
  stream), auth headers all live on the provider.

## Success criteria

- `SendMsg(protocol, ctx)` contains no branching.
- Adding a protocol = one new provider module + one registry line; no union to edit.
- Omitting a field from a provider fails to compile.
- `bun run lint` (Biome + effect LS) is green.

## Testing

- **Registry** — compile-time exhaustiveness (type test) + a runtime test that `SendMsg`
  dispatches to the intended provider.
- **Provider** — unit-test `parse` (valid and invalid input) and `buildRequest`
  (msg + prev → body).
- **HTTP/stream** — exercised against a stubbed fetch / readable stream.

## Out of scope

- Vendors (`openai` / `anthropic` / …) as a second axis.
- Tagged errors, richer `Chunk`, `@effect/platform` migration.
