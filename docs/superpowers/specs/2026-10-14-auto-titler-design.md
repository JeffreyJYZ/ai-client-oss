# Auto-titler (P3) — design

Status: **written; queued for review after P2** (the agreed sequence is P1 → P2 → P3).

## Purpose

A built-in area that names a conversation from its **first user query** using a configurable model — free by default — so the sidebar reads like subjects instead of message fragments.

## What exists today (facts)

- `state/chat.ts`'s `deriveTitle(conversation, msg)` keeps the existing title whenever the conversation has messages **or** the title is no longer `DEFAULT_TITLE` (`"New chat"`). So a title is derived **once, from the first message's text**, and `renameConversation` sets it explicitly — which means **a derived title and a user-renamed one are indistinguishable today**. That single fact shapes this whole design: the titler cannot know whether it is improving a derived title or vandalising a deliberate one unless the source is recorded.
- A side completion already has a precedent: `lib/providers/models.ts`'s `testModel` posts a tiny request through the transport (the native one on desktop since T25), with the endpoint's own headers. The titler reuses that shape rather than inventing a second request path.
- P1 gives every built-in an identity and a toggle, so this is `app.titler` — a tenth area, and the first one added after P1's mechanism exists.

## Goals

1. On the **first** user query of a conversation, ask a model for a short title and set it — **once**.
2. **Never overwrite a title the user renamed.**
3. A **configurable** model, defaulting to a **free** one by a deterministic rule (the app has no price table, so "free" is a choice, not a detection): if a provider whose base URL is on `opencode.ai` exists, its free lane (`step-5-preview-free`); else if an OpenRouter provider exists, `openrouter/free`; else **the titler stays off** with a one-line hint pointing at the model picker. Always overridable.
4. A failure is invisible: the derived title stays, the reason is logged, the turn is never blocked or failed.
5. Toggleable like any built-in (`app.titler`). The area is on by default; with no model resolved it simply does nothing — an honest no-op rather than a broken feature.

## Non-goals

Re-titling old conversations in bulk; a titler that runs on every message; emoji or tag classifiers; any model call that blocks a turn.

## Design

### Storage (additive, no migration)

- `Conversation.titleSource?: "derived" | "model" | "user"` — **absent means `"derived"`**, which is exactly what legacy conversations are, so nothing needs migrating.
- `Settings.titler?: { providerId?: string; model?: string }` — absent means "use the rule above".

### The trigger

- On the **first** user message of a conversation whose `titleSource` is not `"user"`: fire-and-forget, never awaited by the turn, a small completion through the **same transport** as chat, with a prompt that asks for the title only, bounded to a short word count (a named constant, not a literal).
- On success: set the title with `titleSource: "model"`. On failure or refusal: log and leave the derived title.
- Guarded so it runs **once per conversation** (an in-flight set keyed by conversation id), and never for a conversation already `"model"` or `"user"`.

### Where it lives

- A built-in area (`app.titler`): it subscribes to the turn-start signal, decides whether this conversation needs a title, and registers the Settings row for the model choice.
- The completion is a `titleFor()` helper **beside `testModel`** in `lib/providers/models.ts`, reusing that file's transport and header path — the pattern already proven end to end.

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
