# Auto-titler (P3) — design

Status: **reviewed and amended** (2026-10-15; the agreed sequence was P1 → P2 → P3, and P2 shipped as 0.5.0). The review's three blockers are folded in — the operational trigger with its two-part guard, the run mechanism that actually works here (`resolveProviderSync` → an `R = never` effect owned by `host.run`), and the `renameConversation` write plus the schema's `.catch("derived")` — along with sanitization, honest no-op vs resolved-but-failing, and the area count.

## Purpose

A built-in area that names a conversation from its **first user query** using a configurable model — free by default — so the sidebar reads like subjects instead of message fragments.

## What exists today (facts)

- `state/chat.ts`'s `deriveTitle(conversation, msg)` keeps the existing title whenever the conversation has messages **or** the title is no longer `DEFAULT_TITLE` (`"New chat"`). So a title is derived **once, from the first message's text**, and `renameConversation` sets it explicitly — which means **a derived title and a user-renamed one are indistinguishable today**. That single fact shapes this whole design: the titler cannot know whether it is improving a derived title or vandalising a deliberate one unless the source is recorded.
- A side completion already has a precedent: `lib/providers/models.ts`'s `testModel` posts a tiny request through the transport (the native one on desktop since T25), with the endpoint's own headers. The titler reuses that shape rather than inventing a second request path.
- P1 gives every built-in an identity and a toggle, so this is `app.titler` — the first area added after P1's mechanism exists (P2's `app.memory` made it the 13th).

## Goals

1. On the **first** user query of a conversation, ask a model for a short title and set it — **once**.
2. **Never overwrite a title the user renamed.**
3. A **configurable** model, defaulting to a **free** one by a deterministic rule (the app has no price table, so "free" is a choice, not a detection): if a provider whose base URL is on `opencode.ai` exists **with a key set and on a platform that can actually call it** — OpenCode's chat endpoint refuses a browser preflight, so on web this lane is unusable — a **free** id taken from that provider's own cached model list — **never a hardcoded one**: the id an earlier draft named, `step-5-preview-free`, is measured (2026-10-19) to be in *neither* `opencode.ai/zen/v1/models` nor `opencode.ai/inference/go/v1/models`, so a hardcoded id is a permanent, invisible failure for anyone who never pressed "Fetch models"; else if an OpenRouter provider exists **with a key**, `openrouter/free` (present in that lane's live list); else **the titler stays off** with a one-line hint pointing at the model picker. Always overridable. **A provider with no key counts as *unresolved*, not as a request that fails silently**, and a hardcoded free id is a snapshot of a list that moves (`step-5-preview-free` is documented free *for a limited time*; OpenRouter's free router is capped per day) — so the rule prefers an id the provider's own cached model list still carries and otherwise **falls through to the next rung and finally off — never to a paid call** (amended 2026-10-19: an earlier draft read "degrades **to off**", which would abandon a still-free lower rung for no benefit). **An empty cached list carries nothing** — the user never pressed "Fetch models" — so the lane degrades rather than guessing an id, and the hint names that remedy.
4. A failure is invisible: the derived title stays, the reason is logged, the turn is never blocked or failed.
5. Toggleable like any built-in (`app.titler` — the **13th** area, the second added after P1's mechanism exists; an earlier draft called it the tenth, written before P2's `app.memory` landed). The area is on by default; with no model resolved it simply does nothing — an honest no-op rather than a broken feature — and **resolved-but-failing** (a dead id, a refused preflight, a 401) is surfaced in that same one-line place rather than looking like a titler with nothing to say.

## Non-goals

Re-titling old conversations in bulk; a titler that runs on every message; emoji or tag classifiers; any model call that blocks a turn.

## Design

### Storage (additive, no migration)

- `Conversation.titleSource?: "derived" | "model" | "user"` — **absent means `"derived"`**, which is exactly what legacy conversations are, so nothing needs migrating. **It must be `z.enum([...]).optional().catch("derived")`:** `conversationSchema` is a plain object and a failed `safeParse` **discards the whole conversation** (`db/web.ts`, `db/tauri.ts`), so one value outside the enum would make a conversation invisible; the repo's own precedent for a tolerated value is `providerConfigSchema.protocol`'s `.catch(...)`.
- **`renameConversation` must write `titleSource: "user"` together with the title.** The entire never-overwrite guarantee rests on that write and it does not exist today — the function sets `title` alone (`state/chat.ts`). Two writes in that order (derived → user), after which a model title is refused.
- `Settings.titler?: { providerId?: string; model?: string }` — absent means "use the rule above".

### The trigger

- **"The first user message" is defined operationally, because the signal that exists today cannot carry it.** `turn-start` is published *before* the message is appended (`state/chat.ts`) and its payload is `{conversationId, protocol}` only, so a synchronous subscriber sees a conversation with neither messages nor text. The trigger therefore fires **after the append**, and its condition is `messages.length === 1` — there were none before this send — **and** `titleSource` not in `{ "model", "user" }`. **Both halves are required:** `titleSource` alone re-fires on every later send after a first attempt that failed (the in-flight set clears when the request settles while the source stays derived), and it would also title a hydrated **old** conversation on its next send, which the non-goals forbid.
- A first message with **no text** (attachments only) is not a title source: skip it and keep the derived title.
- The prompt asks for a title and nothing else, bounded to a short word count (a named constant). **The reply is sanitized before use** — strip a leading `Title:` label, surrounding quotes, markdown emphasis and a trailing newline — because that is the normal failure mode of a small free model; then cap the length.
- On success: set the title with `titleSource: "model"`. On failure or refusal: **log the reason** and leave the derived title. A *resolved-but-failing* model (a dead id, a refused preflight, a 401) looks identical to a titler with nothing to do, so it is surfaced in the model picker's one-line hint.
- Guarded so it runs **once per conversation** (an in-flight set keyed by conversation id) and never for one already `"model"` or `"user"`. The set is **per page**: two tabs can title the same new conversation, which is harmless (the last write wins on a non-`user` title) but is not "once" — say so rather than implying a lock. **Cancellation:** an in-flight title is abandoned when the area is toggled off — the scope-owned run below provides exactly that, and only that. **Deleting a conversation is *not* covered by that scope** (the scope belongs to the area, not to a conversation): it is covered by the write path re-checking that the conversation still exists, in the same synchronous step as the `titleSource` re-check.

### How it runs (the mechanism — "fire-and-forget" is not one)

- **The shape that works here:** resolve the provider **synchronously** (`resolveProviderSync`, which bridges to the runtime and supplies the context), pass the resolved provider **value** into a `titleFor(...)` whose effect requires **nothing** (`R = never`), and own it with **`host.run`** + `Effect.scoped` inside the area's scope — the structure the memory area already uses for its subscription. The two obvious alternatives fail: `host.run` **cannot run an effect requiring `HostServices`** (its parameter is `R = never` by type and it runs on the empty-context runtime), and `runtime.runFork` carries context but is not scope-owned and leaks past the area.
- **The request is the chat path's, not `testModel`'s.** `testModel` proves the *request* half — transport, endpoint headers, the native one on desktop — but it deliberately never reads a body (it cancels once the status is known) and it does not go through `provider.send` at all (it calls `provider.headers`/`provider.buildRequest`/`chatTransport` directly). The titler needs the body, so it calls **`provider.send(ctx)`** — what the chat path calls — which already yields the parsed chunk stream, with its own message, no tools, and no display.
- **Fold `kind === "text"` chunks only.** Chunks are tagged `text` or `reasoning`; a free model that reasons streams its scratchpad first, and folding everything would put the model's thinking into the sidebar.
- **Pick the session id deliberately:** `testModel` sends a constant probe id and the chat path sends the conversation id. The titler titles a conversation, so it sends that conversation's id.
- **Cost and rate, stated rather than implied:** one call per **new** conversation, on a provider that may differ from the chat's, subject to that provider's free-tier cap; an override onto a paid model costs money.

### Where it lives

- A built-in area (`app.titler`): it subscribes to the **store's own user-message signal** — `state/chat.ts`'s `subscribeUserMessage({conversationId, text})`, published after the append — **not** `turn-start`, which fires before the append and carries no text, and not a new host event, whose name would have to join the bus's closed vocabulary (`lib/plugins/ids.ts`). It decides whether this conversation needs a title and registers the Settings row for the model choice.
- **The `"model"` writer lives in `state/chat.ts`, not in the area:** `titleIfDerived(id, title)` writes `{ title, titleSource: "model" }` only while the conversation still exists *and* the source is still absent/`"derived"` — one synchronous read-check-write, so the re-check and the write cannot be split (the risk below), and so a conversation deleted mid-flight is covered (the area's scope is not per-conversation).
- The completion is a `titleFor()` helper in **`lib/titler.ts`** — deliberately *not* in `lib/providers/models.ts` beside `testModel` as an earlier draft said: `testModel` never reads a body (it cancels once the status is known) while the titler needs the body, and the titler's test wants a provider **value** it can fake. It reuses `provider.send(ctx)` — the one function the chat path and `testModel` both call — so the transport and header path are the proven ones.
- **`titleFor` takes the provider value *and* the credentials** (`provider`, the provider config, `baseUrl`, `apiKey`, `model`, the conversation id, the first message). A `Provider` carries neither `baseUrl` nor `apiKey` nor a model id — those are `SendCtx` inputs — so "pass the provider value" alone is not enough wiring. Its effect requires **nothing** (`R = never`) and fails with a typed `string` cause the caller logs, never a defect.

### Honest UI

One line stating that the conversation's first message is sent to the **titler's** provider, which may differ from the chat's provider; and one stating that a rename is never overwritten.

## Invariants and the tests that pin them

1. **A user-renamed title is never replaced** — rename, then send: the title is unchanged.
2. **Once per conversation** — a second send does not re-title, and two rapid sends produce one request.
3. **A failure is invisible** — a refusing or throwing titler provider leaves the derived title and the turn untouched.
4. **The default rule is deterministic** — the three cases above, each asserted; and the override wins over all three.
5. **Off means zero requests** — with `app.titler` disabled, or with no model resolved, assert that no request is made (not merely that no title changed).

## Success criteria

- A new conversation gets a model-written title, once, without the turn waiting on it.
- Zero requests when the area is off or no model resolves.
- A renamed conversation is never touched.

## Risks

- **Cost and latency:** one tiny completion per new conversation — that is the feature; the default is free and the model is the user's choice.
- **Privacy:** the first message reaches the titler's provider, which may not be the chat's — stated in the UI rather than left to be discovered.
- **A rename racing the request:** the write must re-check `titleSource !== "user"` **at write time**, not only when the request starts. That ordering trap gets its own test, because it is the one a naive implementation gets wrong.

## Out of scope

Re-titling history; per-message titles; emoji; any dependency on which provider the chat itself uses.
