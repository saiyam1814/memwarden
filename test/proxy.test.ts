//
// The memory proxy, end to end: a real proxy server forwarding to a mock
// upstream, recalling from a mock daemon. Asserts the two things that make
// it a memory layer — memory is INJECTED into the upstream request, and the
// answer is CAPTURED back to the daemon — for both JSON and SSE responses.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";

interface Mock {
  port: number;
  close(): Promise<void>;
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Mock> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

async function waitFor(fn: () => boolean, ms = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
});

interface Harness {
  proxyPort: number;
  upstreamSystems: () => string[];
  upstreamAuth: () => string | undefined;
  observed: Array<{ prompt: string; output: string }>;
}

async function harness(
  opts: { stream?: boolean; secret?: string } = {},
): Promise<Harness> {
  let upstreamSystems: string[] = [];
  let upstreamAuth: string | undefined;
  const observed: Array<{ prompt: string; output: string }> = [];

  const daemon = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/memwarden/search") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "Auth uses IAM bearer tokens, 1h TTL." }));
      return;
    }
    if (req.url === "/memwarden/observe") {
      const p = JSON.parse(body) as {
        data?: { tool_input?: { prompt?: string }; tool_output?: string };
      };
      observed.push({
        prompt: p.data?.tool_input?.prompt ?? "",
        output: p.data?.tool_output ?? "",
      });
      res.statusCode = 201;
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  cleanups.push(daemon.close);

  const upstream = await listen(async (req, res) => {
    const body = await readBody(req);
    upstreamAuth = req.headers.authorization;
    const payload = JSON.parse(body) as {
      messages?: Array<{ role: string; content: string }>;
    };
    upstreamSystems = (payload.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    if (opts.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Use IAM " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "tokens." } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Use IAM tokens." } }],
        }),
      );
    }
  });
  cleanups.push(upstream.close);

  const proxy: RunningProxy = startProxyServer({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
    daemonUrl: `http://127.0.0.1:${daemon.port}`,
    project: "/repo",
    cwd: "/repo",
    ...(opts.secret ? { secret: opts.secret } : {}),
  });
  await once(proxy.server, "listening");
  cleanups.push(proxy.close);
  const proxyPort = (proxy.server.address() as AddressInfo).port;

  return {
    proxyPort,
    upstreamSystems: () => upstreamSystems,
    upstreamAuth: () => upstreamAuth,
    observed,
  };
}

async function chat(
  port: number,
  stream: boolean,
  auth?: string,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({
      model: "gpt-test",
      stream,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "How does auth work in this repo?" },
      ],
    }),
  });
  return res.text();
}

describe("memory proxy", () => {
  it("injects recalled memory into the upstream request (JSON)", async () => {
    const h = await harness();
    const reply = await chat(h.proxyPort, false);

    // memory injected as a system message
    const systems = h.upstreamSystems();
    expect(systems.some((s) => s.includes("IAM bearer tokens"))).toBe(true);

    // upstream answer forwarded back to the client unchanged
    expect(reply).toContain("Use IAM tokens.");
  });

  it("captures the exchange back into memory (JSON)", async () => {
    const h = await harness();
    await chat(h.proxyPort, false);
    const captured = await waitFor(() => h.observed.length > 0);
    expect(captured).toBe(true);
    expect(h.observed[0]!.prompt).toContain("How does auth work");
    expect(h.observed[0]!.output).toContain("Use IAM tokens.");
  });

  it("streams SSE through and reconstructs the answer for capture", async () => {
    const h = await harness({ stream: true });
    const reply = await chat(h.proxyPort, true);

    // SSE frames passed through to the client
    expect(reply).toContain("data:");
    expect(reply).toContain("[DONE]");

    // memory still injected, and the streamed answer reassembled on capture
    expect(h.upstreamSystems().some((s) => s.includes("IAM bearer tokens"))).toBe(true);
    const captured = await waitFor(() => h.observed.length > 0);
    expect(captured).toBe(true);
    expect(h.observed[0]!.output).toBe("Use IAM tokens.");
  });

  it("inserts memory after the developer's own system prompt", async () => {
    const h = await harness();
    await chat(h.proxyPort, false);
    const systems = h.upstreamSystems();
    // two system messages: the dev's first, the injected memory second
    expect(systems.length).toBe(2);
    expect(systems[0]).toContain("You are a helpful assistant.");
    expect(systems[1]).toContain("IAM bearer tokens");
  });

  it("survives a client that disconnects mid-stream (no crash, next request works)", async () => {
    // A daemon that returns memory, and an upstream that streams slowly and
    // forever, so we can abort the client while bytes are still flowing.
    const daemon = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "mem" }));
    });
    cleanups.push(daemon.close);
    let timer: NodeJS.Timeout | undefined;
    const upstream = await listen((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`);
      }, 5);
    });
    cleanups.push(() => {
      if (timer) clearInterval(timer);
      return upstream.close();
    });
    const proxy = startProxyServer({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      daemonUrl: `http://127.0.0.1:${daemon.port}`,
      project: "/repo",
      cwd: "/repo",
    });
    await once(proxy.server, "listening");
    cleanups.push(proxy.close);
    const port = (proxy.server.address() as AddressInfo).port;

    // Start a streaming request, then abort it mid-flight.
    const ac = new AbortController();
    const inflight = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "q" }] }),
      signal: ac.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 40)); // let some bytes flow
    ac.abort();
    await inflight;
    await new Promise((r) => setTimeout(r, 40)); // give the server a beat to (not) crash

    // The proxy process must still be serving — a fresh /livez succeeds.
    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(live.status).toBe(200);
    await live.text();
  });
});

describe("memory proxy client auth", () => {
  const SECRET = "test-proxy-secret";

  async function status(
    port: number,
    path: string,
    init: RequestInit = {},
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    await res.text();
    return res.status;
  }

  it("rejects a request without the secret and never touches the upstream", async () => {
    const h = await harness({ secret: SECRET });
    const code = await status(h.proxyPort, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(code).toBe(401);
    // neither forwarded nor captured — the key was not spent, memory not poisoned
    expect(h.upstreamSystems().length).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.observed.length).toBe(0);
  });

  it("rejects a wrong secret", async () => {
    const h = await harness({ secret: SECRET });
    const code = await status(h.proxyPort, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(code).toBe(401);
  });

  it("guards passthrough paths too, not just chat", async () => {
    const h = await harness({ secret: SECRET });
    expect(await status(h.proxyPort, "/v1/models")).toBe(401);
  });

  it("accepts the secret as the tool's API key and strips it before the upstream", async () => {
    const h = await harness({ secret: SECRET });
    const reply = await chat(h.proxyPort, false, `Bearer ${SECRET}`);
    expect(reply).toContain("Use IAM tokens.");
    expect(h.upstreamSystems().some((s) => s.includes("IAM bearer tokens"))).toBe(true);
    // the memwarden secret must never leak to the upstream; with no
    // upstreamKey configured, no Authorization goes out at all
    expect(h.upstreamAuth()).toBeUndefined();
    const captured = await waitFor(() => h.observed.length > 0);
    expect(captured).toBe(true);
  });

  it("leaves /livez open — health checks need no key", async () => {
    const h = await harness({ secret: SECRET });
    expect(await status(h.proxyPort, "/livez")).toBe(200);
  });

  it("stays open when no secret is configured (local-model default)", async () => {
    const h = await harness();
    const reply = await chat(h.proxyPort, false);
    expect(reply).toContain("Use IAM tokens.");
  });
});
