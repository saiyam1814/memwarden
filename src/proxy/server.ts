//
// The memory proxy: an OpenAI-compatible gateway that turns memwarden into
// a universal, automatic memory layer for every tool that speaks the
// /v1/chat/completions protocol — local models (Ollama :11434/v1, LM Studio
// :1234/v1) and paid ones (OpenAI, OpenRouter, Together) alike. They all
// share that one boundary, and the proxy is blind to which is behind it, so
// it is a single memory layer for all of them.
//
// On a chat completion the proxy:
//   1. pulls the latest user turn as a query,
//   2. asks the local daemon for relevant memory (/memwarden/search,
//      narrative format),
//   3. injects it as a system message ahead of the conversation,
//   4. forwards the rewritten request to the configured upstream,
//   5. streams the response straight back to the client unchanged while
//      tee-ing it to reconstruct the assistant's answer,
//   6. captures the user turn + answer into memory (/memwarden/observe).
//
// Everything else (GET /v1/models, etc.) is a transparent passthrough — no
// injection, no capture. The kernel's own HTTP server JSON-buffers every
// response and cannot stream, which is why the proxy is a separate node:http
// server doing raw request/response piping.

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface ProxyOptions {
  /** Port to listen on. */
  port: number;
  host?: string;
  /** Upstream OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
  upstreamUrl: string;
  /** API key forwarded to the upstream as Authorization: Bearer. */
  upstreamKey?: string;
  /** Local memwarden daemon base, e.g. http://127.0.0.1:3111. */
  daemonUrl: string;
  /** Shared secret for the daemon's auth'd routes, if configured. */
  secret?: string;
  /** Project/workspace this proxy's captures belong to (defaults to cwd). */
  project: string;
  /** Working directory used to scope recall. */
  cwd: string;
  /** Token budget for injected memory. */
  tokenBudget?: number;
}

export interface RunningProxy {
  server: Server;
  port: number;
  close(): Promise<void>;
}

interface Ctx extends ProxyOptions {
  sessionId: string;
}

// Hop-by-hop headers must not be forwarded across a proxy boundary.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

export function startProxyServer(opts: ProxyOptions): RunningProxy {
  const host = opts.host ?? "127.0.0.1";
  // One session per proxy process. Turns from different conversations share
  // it; the daemon's dedup keys on the prompt so distinct prompts still land.
  const ctx: Ctx = { ...opts, sessionId: `proxy-${opts.port}` };

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "memwarden_proxy_error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  server.listen(opts.port, host);
  return {
    server,
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/livez") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", service: "memwarden-proxy" }));
    return;
  }

  const isChat =
    req.method === "POST" &&
    (path === "/v1/chat/completions" || path === "/chat/completions");

  const reqBody = await readBody(req);

  // For a chat completion, inject memory and remember the query so we can
  // capture the answer. Other paths pass straight through.
  let outBody = reqBody;
  let query = "";
  if (isChat && reqBody.length) {
    try {
      const payload = JSON.parse(reqBody.toString("utf8")) as ChatRequest;
      query = extractUserQuery(payload);
      if (query) {
        const memory = await fetchMemory(ctx, query).catch(() => "");
        if (memory) {
          outBody = Buffer.from(
            JSON.stringify(injectMemory(payload, memory)),
            "utf8",
          );
        }
      }
    } catch {
      // Not JSON we understand — forward the original bytes untouched.
    }
  }

  const target = new URL(ctx.upstreamUrl + path.replace(/^\/v1/, ""));
  const upstream = await requestUpstream(
    target,
    req.method ?? "GET",
    buildUpstreamHeaders(req.headers, outBody, ctx.upstreamKey),
    outBody.length ? outBody : undefined,
  );

  res.statusCode = upstream.statusCode ?? 502;
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    res.setHeader(k, v as string | string[]);
  }

  // Pipe the response straight back, tee-ing it so we can reconstruct the
  // assistant's answer for capture once the stream finishes.
  const captured: Buffer[] = [];
  const wantCapture = isChat && query !== "";
  upstream.on("data", (chunk: Buffer) => {
    if (wantCapture) captured.push(chunk);
    res.write(chunk);
  });
  upstream.on("end", () => {
    res.end();
    if (wantCapture && (upstream.statusCode ?? 0) < 400) {
      const answer = extractAnswer(
        Buffer.concat(captured),
        upstream.headers["content-type"],
      );
      if (answer) void captureExchange(ctx, query, answer);
    }
  });
  upstream.on("error", () => {
    if (!res.writableEnded) res.end();
  });
}

// --- request/response plumbing -------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildUpstreamHeaders(
  incoming: IncomingMessage["headers"],
  body: Buffer,
  upstreamKey: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization") continue; // overridden below
    if (lower === "accept-encoding") continue; // forced to identity below
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  // Identity encoding so the tee can parse the answer without gunzipping.
  out["accept-encoding"] = "identity";
  if (body.length) out["content-length"] = String(body.length);
  // The client's key (if any) is replaced with the configured upstream key;
  // a local model that needs none simply gets no Authorization header.
  if (upstreamKey) out["authorization"] = `Bearer ${upstreamKey}`;
  return out;
}

function requestUpstream(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === "https:";
    const send = isHttps ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => resolve(res),
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- chat shape + memory injection ---------------------------------

interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}
interface ChatRequest {
  messages?: ChatMessage[];
  [k: string]: unknown;
}

function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractUserQuery(payload: ChatRequest): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return messageText(m.content).trim();
  }
  return "";
}

function injectMemory(payload: ChatRequest, memory: string): ChatRequest {
  const messages = Array.isArray(payload.messages)
    ? payload.messages.slice()
    : [];
  const sys: ChatMessage = {
    role: "system",
    content:
      "# Relevant memory (memwarden)\n" +
      "Context recalled from past sessions. Use it if helpful; ignore if not.\n\n" +
      memory,
  };
  // Insert after any leading system messages so the developer's own system
  // prompt still comes first.
  let at = 0;
  while (at < messages.length && messages[at]?.role === "system") at++;
  messages.splice(at, 0, sys);
  return { ...payload, messages };
}

function extractAnswer(buf: Buffer, contentType: unknown): string {
  const text = buf.toString("utf8");
  const ct = typeof contentType === "string" ? contentType : "";
  if (ct.includes("text/event-stream") || text.startsWith("data:")) {
    let acc = "";
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const piece = obj.choices?.[0]?.delta?.content;
        if (typeof piece === "string") acc += piece;
      } catch {
        // skip malformed SSE frame
      }
    }
    return acc.trim();
  }
  try {
    const obj = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: ChatMessage["content"] } }>;
    };
    const content = obj.choices?.[0]?.message?.content;
    if (content !== undefined) return messageText(content).trim();
  } catch {
    // not JSON
  }
  return "";
}

// --- daemon calls (recall + capture) -------------------------------

function daemonHeaders(secret: string | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (secret) h["authorization"] = `Bearer ${secret}`;
  return h;
}

async function fetchMemory(ctx: Ctx, query: string): Promise<string> {
  const res = await fetch(`${ctx.daemonUrl}/memwarden/search`, {
    method: "POST",
    headers: daemonHeaders(ctx.secret),
    body: JSON.stringify({
      query,
      format: "narrative",
      project: ctx.project,
      cwd: ctx.cwd,
      ...(ctx.tokenBudget ? { token_budget: ctx.tokenBudget } : {}),
    }),
  });
  if (!res.ok) return "";
  const body = (await res.json()) as { text?: string };
  return typeof body.text === "string" ? body.text : "";
}

async function captureExchange(
  ctx: Ctx,
  query: string,
  answer: string,
): Promise<void> {
  await fetch(`${ctx.daemonUrl}/memwarden/observe`, {
    method: "POST",
    headers: daemonHeaders(ctx.secret),
    body: JSON.stringify({
      hookType: "post_tool_use",
      sessionId: ctx.sessionId,
      project: ctx.project,
      cwd: ctx.cwd,
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "chat",
        tool_input: { prompt: query.slice(0, 4000) },
        tool_output: answer.slice(0, 8000),
      },
    }),
  }).catch(() => undefined);
}
