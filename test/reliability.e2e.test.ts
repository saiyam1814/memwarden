//
// The cross-door reliability harness — proof the unified layer actually
// carries memory ACROSS mechanisms, against the real daemon over real HTTP
// and the real MCP dispatch path:
//
//   door A (proxy)  capture  ->  door B (MCP)    recall   — memory crosses
//   door C (hook)   capture  ->  door A (proxy)  recall   — memory crosses
//
// Plus the self-heal contract: a daemon network error triggers ensureUp()
// and one retry, so a dead daemon is revived with no human in the loop.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";

let sdk: Kernel;
let http: RunningHttpServer;
let baseUrl: string;
let project: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-reliability" }, {
    store: new StoreLibsql({ url: ":memory:" }),
  });
  registerCoreFunctions(sdk, new StateKV(sdk));
  registerApiTriggers(sdk);
  http = startHttpServer(sdk, { port: 0 });
  await once(http.server, "listening");
  baseUrl = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  project = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-rel-")));
  cleanups.push(() => rmSync(project, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
});

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
      resolve({ port: (srv.address() as AddressInfo).port });
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

async function waitFor(fn: () => Promise<boolean>, ms = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// A mock upstream that records the request it saw and returns a fixed answer.
async function mockUpstream(answer: string): Promise<{
  port: number;
  saw: () => string;
}> {
  let body = "";
  const { port } = await listen(async (req, res) => {
    body = await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }),
    );
  });
  return { port, saw: () => body };
}

async function startProxy(upstreamPort: number): Promise<number> {
  const proxy: RunningProxy = startProxyServer({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    daemonUrl: baseUrl,
    project,
    cwd: project,
  });
  await once(proxy.server, "listening");
  cleanups.push(() => proxy.close());
  return (proxy.server.address() as AddressInfo).port;
}

async function chat(port: number, userText: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: userText }],
    }),
  });
}

// MCP recall scoped to the project (memory_resume), returning the text.
async function mcpRecall(query: string): Promise<string> {
  const server = createMcpServer({ baseUrl, cwd: project });
  const res = await server.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "memory_resume", arguments: { query } },
  });
  const r = res!.result as { content: Array<{ text: string }> };
  return r.content[0]!.text;
}

describe("cross-door: proxy capture -> MCP recall", () => {
  it("a model call's answer through the proxy is later recalled via MCP", async () => {
    const up = await mockUpstream("Billing uses Stripe webhooks with idempotency keys.");
    const proxyPort = await startProxy(up.port);

    await chat(proxyPort, "how does billing work here?");

    // The proxy captures asynchronously after streaming the response back.
    const crossed = await waitFor(async () =>
      (await mcpRecall("stripe billing")).toLowerCase().includes("stripe"),
    );
    expect(crossed).toBe(true);
  });
});

describe("cross-door: hook capture -> proxy recall", () => {
  it("a hook-captured memory is injected into a later model call by the proxy", async () => {
    // The memory references a real file, so Verified Recall lets it through
    // the proxy's safe_only firewall (a stale one would be dropped).
    writeFileSync(join(project, "deploy.ts"), "// canary pipeline deploy\n");
    // Door C: the hook/observe path captures a memory in this project.
    await fetch(`${baseUrl}/memwarden/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId: "hook-1",
        project,
        cwd: project,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "deploy.ts" },
          tool_output: "deploys go out via the canary pipeline, never direct to prod",
        },
      }),
    });

    // Door A: a later model call through the proxy should get that memory
    // injected — into the USER turn with untrusted-data framing, never a
    // system message (memory must not carry instruction-level authority).
    const up = await mockUpstream("ok");
    const proxyPort = await startProxy(up.port);
    await chat(proxyPort, "how do deploys work?");

    const messages = JSON.parse(up.saw()).messages as Array<{
      role: string;
      content: string;
    }>;
    const systems = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systems.toLowerCase()).not.toContain("canary");
    const users = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    expect(users.toLowerCase()).toContain("canary");
    expect(users).toContain("<memwarden-memory>");
  });
});

describe("self-heal: MCP revives a dead daemon and retries", () => {
  it("a network error triggers ensureUp() then one successful retry", async () => {
    let daemonUp = false;
    const ensureUp = async (): Promise<void> => {
      daemonUp = true;
    };
    const fetchFn = (async () => {
      if (!daemonUp) throw new TypeError("fetch failed: connection refused");
      return new Response(JSON.stringify({ verified: true, oplogEntries: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:59999",
      ensureUp,
      fetchFn,
    });
    const res = await server.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_verify", arguments: {} },
    });
    expect(daemonUp).toBe(true); // ensureUp ran (daemon revived)
    const text = (res!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("verified"); // retry succeeded
  });
});
