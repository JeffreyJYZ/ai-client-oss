/**
 * Proof stub for the desktop app's local companion (see
 * docs/superpowers/specs/2026-10-22-local-companion.md). Never shipped; the
 * token is a literal on purpose so a browser can pair without the desktop app.
 */
const ALLOWED_ORIGINS = new Set([
  "https://aiclient.jyz.land",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "tauri://localhost",
]);

const port = Number(process.env.AI_CLIENT_COMPANION_PORT ?? 47821);
const token = process.env.COMPANION_STUB_TOKEN ?? "stub-token";
const stateDir = process.env.COMPANION_STUB_DIR ?? `${(Bun.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/ai-client-companion-stub`;
const settingsPath = `${stateDir}/settings.json`;

import { mkdirSync } from "node:fs";
try {
  mkdirSync(stateDir, { recursive: true });
} catch {
  // ignore
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function preflightHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    "Access-Control-Allow-Private-Network": "true",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function authOk(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  return h === `Bearer ${token}`;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");

  // Host guard
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return new Response(JSON.stringify({ error: "bad host" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Vary": "Origin" },
    });
  }

  // Origin guard
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Vary": "Origin" },
    });
  }

  const ch = corsHeaders(origin);

  // Preflight (before auth)
  if (req.method === "OPTIONS") {
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 204, headers: preflightHeaders(origin) });
    }
    return new Response(null, { status: 204, headers: { "Vary": "Origin" } });
  }

  const path = url.pathname;

  // GET /v1/ping
  if (req.method === "GET" && path === "/v1/ping") {
    return json({ app: "ai-client", version: "stub", port }, 200, ch);
  }

  // POST /v1/pair
  if (req.method === "POST" && path === "/v1/pair") {
    let body: { token?: string } = {};
    try {
      body = (await req.json()) as { token?: string };
    } catch {
      body = {};
    }
    if (body?.token === token) {
      return json({ ok: true }, 200, ch);
    }
    return json({ error: "bad token" }, 401, ch);
  }

  // Auth check for the rest
  if (!authOk(req)) {
    return json({ error: "unauthorized" }, 401, ch);
  }

  // GET /v1/settings
  if (req.method === "GET" && path === "/v1/settings") {
    const file = Bun.file(settingsPath);
    if (await file.exists()) {
      const text = await file.text();
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json", ...ch },
      });
    }
    return json({ error: "no settings yet" }, 404, ch);
  }

  // PUT /v1/settings
  if (req.method === "PUT" && path === "/v1/settings") {
    const raw = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400, ch);
    }
    const tmp = `${settingsPath}.tmp`;
    await Bun.write(tmp, JSON.stringify(parsed));
    const { renameSync } = await import("node:fs");
    renameSync(tmp, settingsPath);
    return json({ ok: true }, 200, ch);
  }

  // POST /v1/chat
  if (req.method === "POST" && path === "/v1/chat") {
    const body = (await req.json()) as { url: string; headers: Record<string, string>; body: string };
    if (process.env.COMPANION_STUB_UPSTREAM === "echo") {
      const sse = "data: {\"stub\":1}\n\ndata: {\"stub\":2}\n\ndata: [DONE]\n\n";
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", ...ch },
      });
    }
    const upstream = await fetch(body.url, {
      method: "POST",
      headers: body.headers ?? {},
      body: body.body,
    });
    const hopByHop = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "transfer-encoding",
      "upgrade",
    ]);
    const headers = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!hopByHop.has(k.toLowerCase())) headers.set(k, v);
    });
    Object.entries(ch).forEach(([k, v]) => headers.set(k, v));
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  }

  return json({ error: "not found" }, 404, ch);
}

// Bind with port-taken handling
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: handle,
  });
} catch (e) {
  console.error(`companion-stub: could not bind 127.0.0.1:${port} — ${(e as Error).message}`);
  process.exit(1);
}

console.log(`companion-stub: url=http://127.0.0.1:${port} token=${token} dir=${stateDir}`);
