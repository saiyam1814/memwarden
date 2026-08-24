//
// MCP server integration. Boots the full stack on an ephemeral port (the
// same wiring as e2e) and drives the dependency-free MCP dispatcher against
// it: initialize handshake, tool listing, and every tool round-trip
// including the memwarden-only memory_verify and memory_stats. No external
// host, no MCP SDK — pure offline.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/functions/types.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { createMcpServer } from "../src/mcp/server.js";

let sdk: Kernel;
let store: StoreLibsql;
let kv: StateKV;
let http: RunningHttpServer;
let server: ReturnType<typeof createMcpServer>;
let baseUrl: string;
const testDirs: string[] = [];

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  store = new StoreLibsql({ url: ":memory:" });
  sdk = registerWorker("in-process", { workerName: "memwarden-mcp" }, { store });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);
  http = startHttpServer(sdk, { port: 0 });
  await new Promise<void>((r) => {
    if (http.server.listening) r();
    else http.server.once("listening", () => r());
  });
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  server = createMcpServer({ baseUrl });
});

afterEach(async () => {
  for (const dir of testDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
});

function call(method: string, params?: unknown, id: number | null = 1) {
  return server.dispatch({ jsonrpc: "2.0", id, method, params });
}

function tempProject(): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-mcp-search-")));
  testDirs.push(project);
  return project;
}

async function observeOverHttp(
  project: string,
  data: Record<string, unknown>,
  sessionId: string,
  timestamp = "2026-08-24T12:00:00.000Z",
): Promise<void> {
  const res = await fetch(`${baseUrl}/memwarden/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hookType: "post_tool_use",
      sessionId,
      project,
      cwd: project,
      timestamp,
      data,
    }),
  });
  expect(res.status).toBe(201);
  await res.text();
}

async function mcpSearch<T>(
  client: ReturnType<typeof createMcpServer>,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await client.dispatch({
    jsonrpc: "2.0",
    id: 90,
    method: "tools/call",
    params: { name: "memory_search", arguments: args },
  });
  const result = response!.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as T;
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

  it("memory_remember without a project lands in THIS project, not a literal 'mcp' scope", async () => {
    // Regression: remember({text}) used to store project/cwd = "mcp", so a
    // resume from the real repository could never find it.
    await call("tools/call", {
      name: "memory_remember",
      arguments: { text: "decided to gate releases on the conformance suite" },
    });
    const resumed = await call("tools/call", {
      name: "memory_resume",
      arguments: { query: "what did we decide about releases" }, // no cwd: defaults to serverCwd
    });
    const text = (
      resumed!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(text.toLowerCase()).toContain("conformance");
  });

  it("default-sessionId remembers from two projects land in sessions scoped to each project", async () => {
    // Regression (F2): remember({text}) with no sessionId used the literal
    // "mcp" session. A session's project metadata is fixed at creation, so a
    // "mcp" session created under project A made every later default
    // remember from project B searchable under A and invisible to B.
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const alpha = createMcpServer({ baseUrl: base, cwd: "/work/alpha-scope" });
    const beta = createMcpServer({ baseUrl: base, cwd: "/work/beta-scope" });

    // Neither remember names a sessionId or project: both use the defaults.
    await alpha.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: { text: "alpha decided to use IAM tokens for auth" },
      },
    });
    await beta.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_remember",
        arguments: { text: "beta billing runs entirely on stripe webhooks" },
      },
    });

    // Resume from beta must surface beta's memory.
    const resumed = await beta.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_resume",
        arguments: { query: "billing webhooks" },
      },
    });
    const resumeText = (
      resumed!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(resumeText.toLowerCase()).toContain("stripe");

    // And alpha's project-scoped search must NOT see beta's memory.
    const searched = await alpha.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "billing stripe webhooks" },
      },
    });
    const searchText = (
      searched!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(searchText.toLowerCase()).not.toContain("stripe");
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

describe("MCP memory_search trust and inclusion policy over real HTTP", () => {
  interface LabeledResult {
    trust: string;
    source_status: string;
    captured_at: string;
    evidence: string;
    historical: boolean;
    superseded?: true;
    observation?: { narrative?: string };
  }
  interface SearchResponse {
    mode?: string;
    format: string;
    results: LabeledResult[];
    text?: string;
    firewall?: { refused: number };
  }

  it("defaults to balanced current results and requires historical/all mode for source drift", async () => {
    const project = tempProject();
    const file = join(project, "auth.ts");
    writeFileSync(file, "export const legacyAuth = 'bearer-v1';\n");
    await observeOverHttp(
      project,
      {
        tool_name: "Edit",
        tool_input: { file_path: "auth.ts" },
        tool_output: "old auth migration keeps the bearer-v1 compatibility token",
      },
      "search-policy-current",
    );
    const client = createMcpServer({ baseUrl, cwd: project });

    // MCP's no-argument default is mode=current, and FULL output is labeled.
    const before = await mcpSearch<SearchResponse>(client, {
      query: "old auth migration bearer-v1",
    });
    expect(before.mode).toBe("current");
    expect(before.format).toBe("full");
    expect(before.results).toHaveLength(1);
    expect(before.results[0]).toMatchObject({
      trust: "verified",
      source_status: "source-verified",
      captured_at: "2026-08-24T12:00:00.000Z",
      historical: false,
    });
    expect(before.results[0]!.evidence).toMatch(/match their captured hashes/);

    // Once the source changes, default/current COMPACT search refuses it.
    writeFileSync(file, "export const modernAuth = 'oidc-v2';\n");
    const current = await mcpSearch<SearchResponse>(client, {
      query: "old auth migration bearer-v1",
      mode: "current",
      format: "compact",
    });
    expect(current.results).toEqual([]);
    expect(current.firewall?.refused).toBeGreaterThan(0);

    // Explicit historical NARRATIVE search deliberately returns the record,
    // with temporal framing, capture time, and the drift evidence attached.
    const historical = await mcpSearch<SearchResponse>(client, {
      query: "old auth migration bearer-v1",
      mode: "historical",
      format: "narrative",
    });
    expect(historical.mode).toBe("historical");
    expect(historical.results).toHaveLength(1);
    expect(historical.results[0]).toMatchObject({
      trust: "stale",
      source_status: "source-drifted",
      captured_at: "2026-08-24T12:00:00.000Z",
      historical: true,
    });
    expect(historical.results[0]!.evidence).toMatch(/changed: auth\.ts/);
    expect(historical.text).toContain("[source-drifted]");
    expect(historical.text).toContain(
      "Historical record captured 2026-08-24T12:00:00.000Z",
    );

    // include_drifted remains a convenient explicit alias for mode=all.
    const all = await mcpSearch<SearchResponse>(client, {
      query: "old auth migration bearer-v1",
      include_drifted: true,
      format: "compact",
    });
    expect(all.mode).toBe("all");
    expect(all.results[0]!.source_status).toBe("source-drifted");
  });

  it("verified-only raises only the current-recall floor; historical inspection stays available", async () => {
    const project = tempProject();
    const file = join(project, "policy.ts");
    writeFileSync(file, "export const rotation = 'cobalt-weekly';\n");
    await observeOverHttp(
      project,
      {
        tool_name: "Edit",
        tool_input: { file_path: "policy.ts" },
        tool_output: "cobalt rotation policy is weekly and file-backed",
      },
      "verified-policy",
    );
    await observeOverHttp(
      project,
      {
        tool_name: "Bash",
        tool_input: { command: "printf cobalt" },
        tool_output: "ops reported the cobalt rotation policy in a command",
      },
      "sourced-policy",
      "2026-08-24T12:01:00.000Z",
    );
    const client = createMcpServer({ baseUrl, cwd: project });
    const previous = process.env.MEMWARDEN_RECALL_POLICY;
    try {
      delete process.env.MEMWARDEN_RECALL_POLICY;
      const balanced = await mcpSearch<SearchResponse>(client, {
        query: "cobalt rotation policy",
        mode: "current",
        format: "compact",
      });
      expect(new Set(balanced.results.map((item) => item.source_status))).toEqual(
        new Set(["source-verified", "sourced"]),
      );
      for (const item of balanced.results) expect(item.trust).toBeTruthy();

      const sourcedOnly = await mcpSearch<SearchResponse>(client, {
        query: "cobalt rotation policy",
        mode: "current",
        trust: ["sourced"],
        format: "compact",
      });
      expect(sourcedOnly.results).toHaveLength(1);
      expect(sourcedOnly.results[0]!.source_status).toBe("sourced");

      process.env.MEMWARDEN_RECALL_POLICY = "verified-only";
      const strict = await mcpSearch<SearchResponse>(client, {
        query: "cobalt rotation policy",
        mode: "current",
      });
      expect(strict.results).toHaveLength(1);
      expect(strict.results[0]!.source_status).toBe("source-verified");

      writeFileSync(file, "export const rotation = 'amber-daily';\n");
      const history = await mcpSearch<SearchResponse>(client, {
        query: "cobalt rotation policy",
        mode: "historical",
        format: "narrative",
      });
      expect(history.results).toHaveLength(1);
      expect(history.results[0]!.source_status).toBe("source-drifted");
    } finally {
      if (previous === undefined) delete process.env.MEMWARDEN_RECALL_POLICY;
      else process.env.MEMWARDEN_RECALL_POLICY = previous;
    }
  });

  it("historical mode retrieves superseded Memory rows with explicit temporal framing", async () => {
    const project = tempProject();
    const memory: Memory = {
      id: "mem_superseded_auth_v1",
      createdAt: "2026-07-01T08:00:00.000Z",
      updatedAt: "2026-07-02T08:00:00.000Z",
      type: "architecture",
      title: "Retired cedar authentication gateway",
      content: "The cedar gateway was the original authentication boundary.",
      concepts: ["cedar", "authentication"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: false,
      project,
      provenance: {
        command: "user migration note",
        capturedAt: "2026-07-01T08:00:00.000Z",
        userConfirmed: true,
      },
    };
    await kv.set(KV.memories, memory.id, memory);
    const client = createMcpServer({ baseUrl, cwd: project });

    const current = await mcpSearch<SearchResponse>(client, {
      query: "cedar authentication gateway",
      mode: "current",
    });
    expect(current.results).toEqual([]);

    const historical = await mcpSearch<SearchResponse>(client, {
      query: "cedar authentication gateway",
      mode: "historical",
      format: "narrative",
    });
    expect(historical.results).toHaveLength(1);
    expect(historical.results[0]).toMatchObject({
      trust: "sourced",
      source_status: "sourced",
      captured_at: "2026-07-01T08:00:00.000Z",
      historical: true,
      superseded: true,
    });
    expect(historical.text).toContain("[superseded] [sourced]");
    expect(historical.text).toContain("Historical record captured 2026-07-01");
  });

  it("cross-project search verifies each own checkout and labels unavailable ones unverifiable", async () => {
    const liveProject = tempProject();
    const missingProject = tempProject();
    writeFileSync(join(liveProject, "atlas.ts"), "export const atlas = 'live';\n");
    writeFileSync(join(missingProject, "atlas.ts"), "export const atlas = 'gone';\n");
    await observeOverHttp(
      liveProject,
      {
        tool_name: "Edit",
        tool_input: { file_path: "atlas.ts" },
        tool_output: "cross project atlas ledger remains live",
      },
      "cross-live",
    );
    await observeOverHttp(
      missingProject,
      {
        tool_name: "Edit",
        // Absolute capture paths must also become unverifiable when the whole
        // checkout disappears; absence of a checkout is not source drift.
        tool_input: { file_path: join(missingProject, "atlas.ts") },
        tool_output: "cross project atlas ledger checkout will disappear",
      },
      "cross-missing",
    );
    rmSync(missingProject, { recursive: true, force: true });

    const client = createMcpServer({ baseUrl, cwd: liveProject });
    const current = await mcpSearch<SearchResponse>(client, {
      query: "cross project atlas ledger",
      all_projects: true,
      mode: "current",
    });
    expect(current.results).toHaveLength(1);
    expect(current.results[0]!.source_status).toBe("source-verified");

    const all = await mcpSearch<SearchResponse>(client, {
      query: "cross project atlas ledger",
      all_projects: true,
      mode: "all",
    });
    expect(all.results).toHaveLength(2);
    expect(new Set(all.results.map((item) => item.source_status))).toEqual(
      new Set(["source-verified", "unverifiable"]),
    );
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

describe("MCP server surfaces a secured-daemon 401 instead of empty success", () => {
  it("returns an isError tool result naming the auth problem", async () => {
    // A daemon that REQUIRES a secret; an MCP client given none. The client
    // must surface the 401 as a visible error, not a silent "no memory".
    const prev = process.env.MEMWARDEN_SECRET;
    process.env.MEMWARDEN_SECRET = "daemon-only-secret";
    const s = registerWorker("in-process", { workerName: "mw-mcp-401" }, {
      store: new StoreLibsql({ url: ":memory:" }),
    });
    try {
      registerCoreFunctions(s, new StateKV(s));
      registerApiTriggers(s);
      const h = startHttpServer(s, { port: 0 });
      await new Promise<void>((r) =>
        h.server.listening ? r() : h.server.once("listening", () => r()),
      );
      const addr = h.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const client = createMcpServer({ baseUrl: `http://127.0.0.1:${port}` }); // no secret
      const res = await client.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "anything" } },
      });
      const r = res!.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text.toLowerCase()).toContain("unauthorized");
      await h.close().catch(() => undefined);
    } finally {
      await s.shutdown();
      if (prev === undefined) delete process.env.MEMWARDEN_SECRET;
      else process.env.MEMWARDEN_SECRET = prev;
    }
  });
});
