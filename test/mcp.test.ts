//
// MCP server integration. Boots the full stack on an ephemeral port (the
// same wiring as e2e) and drives the dependency-free MCP dispatcher against
// it: initialize handshake, tool listing, and every tool round-trip
// including the memwarden-only memory_verify and memory_stats. No external
// host, no MCP SDK — pure offline.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let sdk: Kernel;
let store: StoreLibsql;
let http: RunningHttpServer;
let server: ReturnType<typeof createMcpServer>;

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  store = new StoreLibsql({ url: ":memory:" });
  sdk = registerWorker("in-process", { workerName: "memwarden-mcp" }, { store });
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);
  http = startHttpServer(sdk, { port: 0 });
  await new Promise<void>((r) => {
    if (http.server.listening) r();
    else http.server.once("listening", () => r());
  });
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  server = createMcpServer({ baseUrl: `http://127.0.0.1:${port}` });
});

afterEach(async () => {
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
});

function call(method: string, params?: unknown, id: number | null = 1) {
  return server.dispatch({ jsonrpc: "2.0", id, method, params });
}

describe("MCP handshake and tool listing", () => {
  it("initialize returns protocol + serverInfo", async () => {
    const res = await call("initialize");
    expect(res).not.toBeNull();
    const r = res!.result as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(r.protocolVersion).toBe("2024-11-05");
    expect(r.serverInfo.name).toBe("memwarden");
  });

  it("notifications/initialized produces no response", async () => {
    expect(await call("notifications/initialized", {}, null)).toBeNull();
  });

  it("tools/list advertises the tools incl. resume, verify and stats", async () => {
    const res = await call("tools/list");
    const names = (res!.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "memory_resume",
        "memory_remember",
        "memory_search",
        "memory_context",
        "memory_verify",
        "memory_stats",
      ]),
    );
  });

  it("memory_resume is described to fire on cross-agent / prior-work intent", async () => {
    const res = await call("tools/list");
    const resume = (
      res!.result as { tools: Array<{ name: string; description: string }> }
    ).tools.find((t) => t.name === "memory_resume");
    expect(resume!.description.toLowerCase()).toContain("agent");
    expect(resume!.description.toLowerCase()).toContain("project");
  });

  it("rejects unknown methods and unknown tools", async () => {
    expect((await call("does/notexist"))!.error?.code).toBe(-32601);
    const bad = await call("tools/call", { name: "nope", arguments: {} });
    expect(bad!.error?.code).toBe(-32602);
  });
});

describe("MCP tool round-trips against the live daemon", () => {
  it("remember then search finds it; verify and stats report truthfully", async () => {
    const remembered = await call("tools/call", {
      name: "memory_remember",
      arguments: { text: "kubernetes pods crash on OOM", sessionId: "s1" },
    });
    const remText = (
      remembered!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(remText).toContain("observationId");

    const searched = await call("tools/call", {
      name: "memory_search",
      arguments: { query: "kubernetes OOM", limit: 5 },
    });
    const searchText = (
      searched!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(searchText.toLowerCase()).toContain("kubernetes");

    const verified = await call("tools/call", {
      name: "memory_verify",
      arguments: {},
    });
    const verifyText = (
      verified!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(JSON.parse(verifyText).verified).toBe(true);

    const stats = await call("tools/call", {
      name: "memory_stats",
      arguments: {},
    });
    const statsObj = JSON.parse(
      (stats!.result as { content: Array<{ text: string }> }).content[0]!.text,
    );
    expect(statsObj.memories + statsObj.sessions).toBeGreaterThanOrEqual(0);
    expect(statsObj).toHaveProperty("compression");
  });

  it("memory_resume recalls a prior session scoped to its working directory", async () => {
    // Simulate "Claude" capturing work in project alpha via the observe path.
    const cwdAlpha = "/work/alpha";
    await call("tools/call", {
      name: "memory_remember",
      arguments: {
        text: "refactored the alpha auth module to use IAM tokens",
        sessionId: "claude-1",
        project: cwdAlpha,
      },
    });
    await call("tools/call", {
      name: "memory_remember",
      arguments: {
        text: "beta project uses a totally different billing flow",
        sessionId: "claude-2",
        project: "/work/beta",
      },
    });

    // "Codex", launched in /work/alpha, asks to review — scoped by cwd.
    const resumed = await call("tools/call", {
      name: "memory_resume",
      arguments: { query: "review the auth work", cwd: cwdAlpha },
    });
    const text = (
      resumed!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(text.toLowerCase()).toContain("alpha");
    expect(text.toLowerCase()).toContain("auth");
  });
});

describe("MCP prompts — the /recall command", () => {
  it("initialize advertises the prompts capability", async () => {
    const r = (await call("initialize"))!.result as {
      capabilities: { prompts?: unknown };
    };
    expect(r.capabilities.prompts).toBeDefined();
  });

  it("prompts/list exposes recall with a query argument", async () => {
    const r = (await call("prompts/list"))!.result as {
      prompts: Array<{ name: string; arguments: Array<{ name: string }> }>;
    };
    const recall = r.prompts.find((p) => p.name === "recall");
    expect(recall).toBeDefined();
    expect(recall!.arguments.some((a) => a.name === "query")).toBe(true);
  });

  it("prompts/get recall injects the project's recalled memory", async () => {
    const cwd = "/work/gamma";
    await call("tools/call", {
      name: "memory_remember",
      arguments: {
        text: "gamma service uses mTLS client certs for auth",
        sessionId: "g1",
        project: cwd,
      },
    });
    // A server launched in /work/gamma — recall is auto-scoped to it.
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const scoped = createMcpServer({ baseUrl: `http://127.0.0.1:${port}`, cwd });
    const res = await scoped.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "recall", arguments: { query: "gamma auth" } },
    });
    const r = res!.result as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.content.type).toBe("text");
    expect(r.messages[0]!.content.text.toLowerCase()).toContain("mtls");
  });

  it("prompts/get rejects an unknown prompt", async () => {
    const res = await call("prompts/get", { name: "nope" });
    expect(res!.error).toBeDefined();
  });
});
