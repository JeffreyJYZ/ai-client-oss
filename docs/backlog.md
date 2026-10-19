# Backlog

Queued work, not yet planned. Each item states what was asked and the constraint that makes it non-trivial, so a future session starts informed instead of re-deriving it.

## `/docs` on the website — all app documentation in one place

**Status: scheduled 2026-10-12 while this entry was still open — now Phase 5 / Task 23 in `docs/superpowers/plans/2026-10-12-plugin-system.md`, which is the source of truth for it.** Everything below stays as the constraint analysis that shaped the task. **Two requirements the user added when scheduling it:** the page must *update as the work progresses*, and the **plugin API reference is its most important part** — which is why Task 23 **generates** the reference from the shipped types and gates it with a coverage test, instead of writing signatures by hand.

**Asked for:** 2026-10-12 (user, while the plugin-system branch was running). A `/docs` route on the website holding the app's documentation.

**What already exists:** the website is the same `web/` frontend, built by Vite and deployed to Vercel (project `ai-client-oss-site`, team `jeffreys-projects-b51c8adf`, Git-connected to `main`, Root Directory `web`). The Tauri desktop build is the same app; `isDesktop` (`web/src/lib/platform.ts`) is what distinguishes them, and the web build shows the "Download desktop app" link (`web/src/constants/app.ts`-adjacent, see `web/src/constants/links.ts`).

**The constraint that makes this a task and not a ten-minute job:** the web build has **no router** — a single-page React app with no `react-router`, and Vercel serves `index.html` for `/` only. So `/docs` does not exist as a path today: it needs one of
- a Vite multi-page entry (`web/docs.html` → emitted to `/docs/` by the build), no new dependency;
- a client router (a new dependency) plus a Vercel rewrite for `/docs/*`;
- or static generation of the markdown sources.

**Content sources to draw from:** `README.md`, `docs/superpowers/specs/*` (designs), `docs/superpowers/plans/*` (implementation plans), and later `web/plugins/README.md` (the plugin author guide, added by the plugin-system plan's Task 19).

**Open question for whoever picks this up:** curated user-facing docs (setup, providers, plugins, trust model) versus rendering everything in `docs/` as-is. The former is a writing job; the latter is largely a rendering job.

## Plugin examples — what is still uncovered

**Status: the largest gaps closed 2026-10-19** — `history-pipeline`, `sidebar-notes`, `zen-view` and `markdown-callouts` shipped with `web/plugins/README.md`'s table pointing at each, and `web/src/lib/plugins/examples.test.ts` now typechecks every example and pins the registrations its `setup` makes. **Still without an example:** `providers.register` (a protocol is a full streaming implementation — a subtly wrong copy is worse than a pointer, so the guide points at `lib/plugins/builtin/` instead), `native.http`, six of the eight events, and 20 of the 22 slots. Add one when a real question needs it, and add its row to the guide in the same commit — `examples.test.ts` fails otherwise.
