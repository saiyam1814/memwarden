//
// Observability: the token-reduction and latency math, plus an end-to-end
// check that real observe/search/context traffic shows up in /stats.

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
import { metrics, estimateTokens } from "../src/observability/metrics.js";

describe("metrics math", () => {
  beforeEach(() => metrics.reset());

  it("reports observe token reduction", () => {
    metrics.recordObserve("x".repeat(300), "x".repeat(60)); // 100 -> 20 tokens
    const snap = metrics.snapshot() as {
      observe: { rawTokens: number; storedTokens: number; reductionPct: number };
    };
    expect(snap.observe.rawTokens).toBe(100);
    expect(snap.observe.storedTokens).toBe(20);
    expect(snap.observe.reductionPct).toBe(80);
  });

  it("reports context reduction and latency percentiles", () => {
    metrics.recordContext(1000, 250, 5);
    metrics.recordContext(1000, 250, 15);
    const snap = metrics.snapshot() as {
      context: { reductionPct: number; latencyMs: { p50: number; p95: number } };
    };
    expect(snap.context.reductionPct).toBe(75);
    expect(snap.context.latencyMs.p95).toBeGreaterThanOrEqual(
      snap.context.latencyMs.p50,
    );
  });

  it("estimateTokens is the shared ~3 chars/token heuristic", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("reset clears everything", () => {
    metrics.recordSearch(10);
    metrics.reset();
    const snap = metrics.snapshot() as { search: { count: number } };
    expect(snap.search.count).toBe(0);
  });
});

describe("metrics surface in /stats end-to-end", () => {
  let sdk: Kernel;
  let store: StoreLibsql;
  let http: RunningHttpServer;
  let base: string;

  beforeEach(async () => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    metrics.reset();
    store = new StoreLibsql({ url: ":memory:" });
    sdk = registerWorker("in-process", { workerName: "memwarden-metrics" }, { store });
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
    base = `http://127.0.0.1:${port}/memwarden`;
  });

  afterEach(async () => {
    await http.close().catch(() => undefined);
    await sdk.shutdown();
    __resetKernelSingleton();
  });

  it("observe + search populate the performance block", async () => {
    await fetch(`${base}/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId: "s1",
        project: "p",
        cwd: "/p",
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Grep",
          tool_input: { pattern: "auth" },
          tool_output: "x".repeat(2000),
        },
      }),
    });
    await fetch(`${base}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "auth" }),
    });

    const stats = await (await fetch(`${base}/stats`)).json();
    expect(stats.performance.observe.count).toBeGreaterThanOrEqual(1);
    expect(stats.performance.observe.rawTokens).toBeGreaterThan(0);
    expect(stats.performance.search.count).toBeGreaterThanOrEqual(1);
    // search latency is recorded as a number (retrieval is sub-second)
    expect(typeof stats.performance.search.latencyMs.p50).toBe("number");
  });
});
