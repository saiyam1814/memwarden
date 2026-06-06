//
// Exercises the three ported core functions (mem::observe / mem::search /
// mem::context) against the kernel + StoreMemory, plus their HTTP routes
// for wire-compatibility (201 on observe, 200 on search/context, 400 on
// bad input, auth open when no secret). Also pins the load-bearing BM25 +
// RRF behavior: a synthetic observation written by the observe path is
// retrievable by keyword, and the search index rebuilds lazily from KV.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  // Fresh BM25 index between tests: it is a module singleton, so clear it.
  getSearchIndex().clear();
  const store = new StoreMemory();
  sdk = registerWorker("in-process", { workerName: "memwarden-fn" }, { store });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  __resetKernelSingleton();
});

function observePayload(over: Record<string, unknown> = {}) {
  return {
    hookType: "post_tool_use",
    sessionId: "sess-A",
    project: "proj-X",
    cwd: "/work/proj-X",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Grep",
      tool_input: { pattern: "authentication", path: "src/auth.ts" },
      tool_output: "found 3 matches for authentication in src/auth.ts",
    },
    ...over,
  };
}

describe("mem::observe (write path)", () => {
  it("validates required fields", async () => {
    const r = await sdk.trigger({
      function_id: "mem::observe",
      payload: { hookType: "", sessionId: "", timestamp: "" },
    });
    expect(r).toMatchObject({ success: false });
  });

  it("persists a raw + synthetic observation and creates the session", async () => {
    const r = await sdk.trigger<unknown, { observationId?: string }>({
      function_id: "mem::observe",
      payload: observePayload(),
    });
    expect(r.observationId).toMatch(/^obs_/);

    // Observation stored under the session's scope.
    const obs = await kv.list(KV.observations("sess-A"));
    expect(obs).toHaveLength(1);

    // Session row created with observationCount = 1.
    const session = await kv.get<{ observationCount: number; project: string }>(
      KV.sessions,
      "sess-A",
    );
    expect(session).toMatchObject({ observationCount: 1, project: "proj-X" });
  });

  it("increments observationCount on subsequent observations for the same session", async () => {
    await kv.set(KV.sessions, "sess-A", {
      id: "sess-A",
      project: "proj-X",
      cwd: "/work/proj-X",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 0,
    });
    // Distinct tool_input on each so the dedup map (sessionId+tool+input)
    // does not suppress the second observation.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload({
        data: { tool_name: "Grep", tool_input: { pattern: "first" } },
      }),
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload({
        data: { tool_name: "Grep", tool_input: { pattern: "second" } },
      }),
    });
    const session = await kv.get<{ observationCount: number }>(
      KV.sessions,
      "sess-A",
    );
    expect(session?.observationCount).toBe(2);
  });

  it("deduplicates identical consecutive observations within the TTL window", async () => {
    await kv.set(KV.sessions, "sess-A", {
      id: "sess-A",
      project: "proj-X",
      cwd: "/work/proj-X",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 0,
    });
    await sdk.trigger({ function_id: "mem::observe", payload: observePayload() });
    const second = await sdk.trigger<unknown, { deduplicated?: boolean }>({
      function_id: "mem::observe",
      payload: observePayload(),
    });
    expect(second).toMatchObject({ deduplicated: true });
  });

  it("redacts secrets so they never persist (matches the original implementation privacy stripping)", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload({
        hookType: "prompt_submit",
        data: {
          prompt:
            "here is my key sk-ant-abcdefghijklmnopqrstuvwxyz01 please use it",
        },
      }),
    });
    const obs = await kv.list(KV.observations("sess-A"));
    // The security guarantee: the secret token is gone from everything that
    // persists, and the redaction marker is present.
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("sk-ant-abcdefghij");
    expect(serialized).toContain("REDACTED_SECRET");
  });
});

describe("mem::search (BM25)", () => {
  it("rejects an empty query", async () => {
    await expect(
      sdk.trigger({ function_id: "mem::search", payload: { query: "  " } }),
    ).rejects.toThrow(/non-empty string/);
  });

  it("retrieves an observation written by the observe path by keyword", async () => {
    await sdk.trigger({ function_id: "mem::observe", payload: observePayload() });

    const res = await sdk.trigger<
      unknown,
      { results: Array<{ observation: { id: string } }> }
    >({
      function_id: "mem::search",
      payload: { query: "authentication" },
    });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.observation.title).toBe("Grep");
  });

  it("lazily rebuilds the BM25 index from KV when empty", async () => {
    // Write directly to KV (no observe), so the index is empty until search.
    await kv.set(KV.sessions, "sess-B", {
      id: "sess-B",
      project: "proj-Y",
      cwd: "/y",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations("sess-B"), "obs_seed_1", {
      id: "obs_seed_1",
      sessionId: "sess-B",
      timestamp: new Date().toISOString(),
      type: "search",
      title: "kubernetes deployment",
      facts: [],
      narrative: "rolled out the kubernetes deployment manifest",
      concepts: [],
      files: [],
      importance: 5,
    });
    expect(getSearchIndex().size).toBe(0);

    const res = await sdk.trigger<unknown, { results: unknown[] }>({
      function_id: "mem::search",
      payload: { query: "kubernetes" },
    });
    expect(res.results.length).toBe(1);
    expect(getSearchIndex().size).toBeGreaterThan(0);
  });

  it("honors the project filter", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload({ sessionId: "sess-X", project: "proj-X" }),
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload({ sessionId: "sess-Z", project: "proj-Z" }),
    });

    const res = await sdk.trigger<
      unknown,
      { results: Array<{ sessionId: string }> }
    >({
      function_id: "mem::search",
      payload: { query: "authentication", project: "proj-Z" },
    });
    expect(res.results.every((r) => r.sessionId === "sess-Z")).toBe(true);
  });

  it("supports the compact format with a token budget", async () => {
    await sdk.trigger({ function_id: "mem::observe", payload: observePayload() });
    const res = await sdk.trigger<
      unknown,
      {
        format: string;
        results: Array<{ obsId: string }>;
        tokens_budget?: number;
        truncated: boolean;
      }
    >({
      function_id: "mem::search",
      payload: { query: "authentication", format: "compact", token_budget: 50 },
    });
    expect(res.format).toBe("compact");
    expect(res.tokens_budget).toBe(50);
    expect(typeof res.truncated).toBe("boolean");
  });
});

describe("mem::context (recency packing)", () => {
  it("returns empty context when nothing is available", async () => {
    const res = await sdk.trigger<unknown, { context: string; blocks: number }>(
      {
        function_id: "mem::context",
        payload: { sessionId: "sess-A", project: "proj-X" },
      },
    );
    expect(res).toEqual({ context: "", blocks: 0, tokens: 0 });
  });

  it("assembles context from other sessions' important observations", async () => {
    // Another session in the same project with an important observation.
    await kv.set(KV.sessions, "sess-prior", {
      id: "sess-prior",
      project: "proj-X",
      cwd: "/work/proj-X",
      startedAt: new Date(Date.now() - 1000).toISOString(),
      status: "completed",
      observationCount: 1,
    });
    await kv.set(KV.observations("sess-prior"), "obs_imp_1", {
      id: "obs_imp_1",
      sessionId: "sess-prior",
      timestamp: new Date().toISOString(),
      type: "decision",
      title: "Chose libSQL for persistence",
      facts: [],
      narrative: "Picked libSQL over flat-file KV for real list-by-scope.",
      concepts: [],
      files: [],
      importance: 8,
    });

    const res = await sdk.trigger<
      unknown,
      { context: string; blocks: number; tokens: number }
    >({
      function_id: "mem::context",
      payload: { sessionId: "sess-current", project: "proj-X", budget: 4000 },
    });
    expect(res.blocks).toBeGreaterThan(0);
    expect(res.context).toContain('<the original implementation-context project="proj-X">');
    expect(res.context).toContain("Chose libSQL for persistence");
    expect(res.tokens).toBeGreaterThan(0);
  });

  it("excludes the current session from its own context", async () => {
    await kv.set(KV.sessions, "sess-self", {
      id: "sess-self",
      project: "proj-X",
      cwd: "/work/proj-X",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations("sess-self"), "obs_self_1", {
      id: "obs_self_1",
      sessionId: "sess-self",
      timestamp: new Date().toISOString(),
      type: "decision",
      title: "self-only observation",
      facts: [],
      narrative: "should not appear in own context",
      concepts: [],
      files: [],
      importance: 9,
    });
    const res = await sdk.trigger<unknown, { context: string }>({
      function_id: "mem::context",
      payload: { sessionId: "sess-self", project: "proj-X" },
    });
    expect(res.context).not.toContain("self-only observation");
  });
});

describe("HTTP routes (wire compatibility)", () => {
  it("serves observe (201) / search (200) / context (200) and 400 on bad input", async () => {
    registerApiTriggers(sdk);
    const http = startHttpServer(sdk, { port: 0 });
    await new Promise((r) => setTimeout(r, 30));
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}/memwarden`;

    try {
      // livez (no auth).
      const live = await fetch(`${base}/livez`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: "ok" });

      // observe -> 201.
      const obs = await fetch(`${base}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(observePayload()),
      });
      expect(obs.status).toBe(201);
      const obsBody = (await obs.json()) as { observationId?: string };
      expect(obsBody.observationId).toMatch(/^obs_/);

      // observe missing fields -> 400.
      const bad = await fetch(`${base}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hookType: "post_tool_use" }),
      });
      expect(bad.status).toBe(400);

      // search -> 200.
      const search = await fetch(`${base}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "authentication" }),
      });
      expect(search.status).toBe(200);
      const searchBody = (await search.json()) as { results: unknown[] };
      expect(Array.isArray(searchBody.results)).toBe(true);

      // search empty query -> 400.
      const searchBad = await fetch(`${base}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "" }),
      });
      expect(searchBad.status).toBe(400);

      // context -> 200.
      const ctx = await fetch(`${base}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-A", project: "proj-X" }),
      });
      expect(ctx.status).toBe(200);

      // context missing fields -> 400.
      const ctxBad = await fetch(`${base}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-A" }),
      });
      expect(ctxBad.status).toBe(400);
    } finally {
      await http.close();
      await sdk.shutdown();
    }
  });
});
