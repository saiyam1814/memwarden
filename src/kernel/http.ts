//
// The kernel's HTTP front door. A node:http server that matches
// registered `type:"http"` routes by method + path, parses the JSON
// body into `req.body`, runs the middleware chain, invokes the bound
// function, and serializes its `{status_code, headers?, body}` return.
// Answers CORS preflight per the configured origins.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { HttpRoute, Kernel } from "./kernel.js";
import type { HttpMethod } from "./types.js";

export interface HttpServerOptions {
  port: number;
  host?: string;
  /** Allowed CORS origins. Defaults to the local viewer/REST quartet. */
  allowedOrigins?: string[];
  /** Max request body bytes before 413. Defaults to 16 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_ORIGINS = [
  "http://localhost:3111",
  "http://localhost:3113",
  "http://127.0.0.1:3111",
  "http://127.0.0.1:3113",
];
const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization";
const DEFAULT_MAX_BODY = 16 * 1024 * 1024;

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startHttpServer(
  kernel: Kernel,
  opts: HttpServerOptions,
): RunningHttpServer {
  const host = opts.host ?? "127.0.0.1";
  const allowedOrigins = opts.allowedOrigins ?? DEFAULT_ORIGINS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  // Index routes by `METHOD path` for O(1) exact-match lookup.
  const routeIndex = new Map<string, HttpRoute>();
  for (const route of kernel.getHttpRoutes()) {
    routeIndex.set(routeKey(route.method, route.path), route);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, kernel, routeIndex, {
      allowedOrigins,
      maxBodyBytes,
    }).catch((err) => {
      // Last-resort guard: never let a handler throw take down the
      // connection without a response.
      if (!res.headersSent) {
        sendJson(res, 500, undefined, {
          error: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  server.listen(opts.port, host);

  return {
    server,
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: Kernel,
  routeIndex: Map<string, HttpRoute>,
  cfg: { allowedOrigins: string[]; maxBodyBytes: number },
): Promise<void> {
  const origin = req.headers.origin;
  applyCors(res, origin, cfg.allowedOrigins);

  const method = (req.method ?? "GET").toUpperCase();

  // CORS preflight.
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  const route = routeIndex.get(routeKey(method as HttpMethod, pathname));
  if (!route) {
    sendJson(res, 404, undefined, { error: "not_found", path: pathname });
    return;
  }

  const headers = normalizeHeaders(req.headers);
  const queryParams = queryToRecord(url);

  // Middleware chain (auth). Short-circuits on `respond`.
  const short = await kernel.runMiddleware(route.middlewareFunctionIds, headers);
  if (short) {
    sendJson(res, short.status_code, undefined, short.body);
    return;
  }

  // Parse the JSON body for methods that carry one.
  let body: unknown;
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    const parsed = await readJsonBody(req, cfg.maxBodyBytes);
    if (parsed.error) {
      sendJson(res, parsed.status, undefined, { error: parsed.error });
      return;
    }
    body = parsed.value;
  }

  const apiRequest: {
    body?: unknown;
    headers: Record<string, string | undefined>;
    query_params: Record<string, string>;
  } = { headers, query_params: queryParams };
  if (body !== undefined) apiRequest.body = body;

  const response = await kernel.invokeHttp(route.functionId, apiRequest);
  sendJson(res, response.status_code, response.headers, response.body);
}

// --- helpers --------------------------------------------------------

function routeKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

function applyCors(
  res: ServerResponse,
  origin: string | undefined,
  allowedOrigins: string[],
): void {
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Vary", "Origin");
}

function normalizeHeaders(
  raw: IncomingMessage["headers"],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function queryToRecord(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

interface ParsedBody {
  value?: unknown;
  error?: string;
  status: number;
}

function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ParsedBody> {
  return new Promise<ParsedBody>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        resolve({ error: "payload_too_large", status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve({ value: {}, status: 200 });
        return;
      }
      const text = Buffer.concat(chunks).toString("utf-8").trim();
      if (!text) {
        resolve({ value: {}, status: 200 });
        return;
      }
      try {
        resolve({ value: JSON.parse(text), status: 200 });
      } catch {
        resolve({ error: "invalid_json", status: 400 });
      }
    });
    req.on("error", () => {
      if (!aborted) resolve({ error: "request_error", status: 400 });
    });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> | undefined,
  body: unknown,
): void {
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(body ?? null));
}
