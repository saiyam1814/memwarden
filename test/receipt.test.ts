//
// mem::forget with delete receipts, end to end through the real kernel +
// oplog: the deletion actually removes the data, the receipt cites real
// chain entries whose hashes verify, a missing id is an honest failure
// (never `{deleted: false... success}` theater), and the HTTP route is
// wire-compatible.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  registerWorker,
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
import type { ForgetResult } from "../src/functions/receipt.js";

let sdk: Kernel;
let kv: StateKV;
let store: StoreMemory;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  store = new StoreMemory();
  sdk = registerWorker("in-process", { workerName: "memwarden-receipt" }, { store });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  __resetKernelSingleton();
});

async function observe(narrative: string): Promise<string> {
  const result = await sdk.trigger<unknown, { observationId: string }>({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: "sess-R",
      project: "proj-R",
      cwd: "/work/proj-R",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Bash", tool_input: { command: "x" }, tool_output: narrative },
    },
  });
  return result.observationId;
}

describe("mem::forget", () => {
  it("deletes the observation and the receipt cites verifiable chain entries", async () => {
    const obsId = await observe("learned that the auth flow uses bearer tokens");

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::forget",
      payload: { observationId: obsId },
    });

    expect(r.deleted).toBe(true);
    const rec = r.receipt!;
    expect(rec.obsId).toBe(obsId);
    expect(rec.chainIntact).toBe(true);
    expect(rec.createEntry).not.toBeNull();
    expect(rec.deleteEntry).not.toBeNull();
    expect(rec.deleteEntry!.op).toBe("delete");

    // the data is really gone from KV
    const gone = await kv.get(KV.observations("sess-R"), obsId);
    expect(gone).toBeNull();

    // the receipt's chain entries exist in the REAL oplog with matching hashes
    const oplog = await store.readOplog();
    const del = oplog.find((e) => e.id === rec.deleteEntry!.id);
    expect(del?.hash).toBe(rec.deleteEntry!.hash);
    expect(del?.key).toBe(obsId);
    const created = oplog.find((e) => e.id === rec.createEntry!.id);
    expect(created?.hash).toBe(rec.createEntry!.hash);

    // receipts never re-disclose content
    expect(JSON.stringify(rec)).not.toContain("bearer tokens");

    // the receipt hash is offline-recomputable from its fields
    const recomputed = createHash("sha256")
      .update(
        JSON.stringify({
          obsId: rec.obsId,
          title: rec.title,
          deletedAt: rec.deletedAt,
          deleteEntry: rec.deleteEntry,
          createEntry: rec.createEntry,
          chainIntact: rec.chainIntact,
          contentErased: rec.contentErased,
          chainHead: rec.chainHead,
        }),
      )
      .digest("hex");
    expect(rec.receiptHash).toBe(recomputed);
  });

  it("forgotten memories disappear from search", async () => {
    const obsId = await observe("the websocket reconnect backoff is exponential");
    let found = await sdk.trigger<unknown, { results: unknown[] }>({
      function_id: "mem::search",
      payload: { query: "websocket reconnect backoff" },
    });
    expect(found.results.length).toBeGreaterThan(0);

    await sdk.trigger({ function_id: "mem::forget", payload: { observationId: obsId } });

    found = await sdk.trigger<unknown, { results: unknown[] }>({
      function_id: "mem::search",
      payload: { query: "websocket reconnect backoff" },
    });
    expect(found.results.length).toBe(0);
  });

  it("reports an honest failure for an unknown id — no fake success, no receipt", async () => {
    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::forget",
      payload: { observationId: "obs_nope" },
    });
    expect(r.deleted).toBe(false);
    expect(r.reason).toContain("obs_nope");
    expect(r.receipt).toBeUndefined();
  });

  it("HTTP route: 400 without an id, 200 with receipt on success", async () => {
    const { registerApiTriggers } = await import("../src/triggers/api.js");
    registerApiTriggers(sdk, kv);
    const obsId = await observe("route-level forget works");

    const bad = await sdk.invokeHttp("api::forget", { headers: {}, query_params: {}, body: {} });
    expect(bad.status_code).toBe(400);

    const ok = await sdk.invokeHttp("api::forget", {
      headers: {},
      query_params: {},
      body: { observation_id: obsId },
    });
    expect(ok.status_code).toBe(200);
    expect((ok.body as ForgetResult).deleted).toBe(true);
    expect((ok.body as ForgetResult).receipt?.chainIntact).toBe(true);
  });
});
