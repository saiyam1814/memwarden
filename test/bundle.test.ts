//
// Brain Bundle export/import. Populates one store, exports, imports into a
// fresh store, and asserts the memory survived the move — including that
// search works against the imported data.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import {
  exportBundle,
  importBundle,
  isBrainBundle,
  BRAIN_BUNDLE_KIND,
} from "../src/bundle/bundle.js";

function freshKernel(name: string): { sdk: Kernel; kv: StateKV } {
  __resetKernelSingleton();
  getSearchIndex().clear();
  const sdk = registerWorker("in-process", { workerName: name }, {
    store: new StoreMemory(),
  });
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  return { sdk, kv };
}

afterEach(() => __resetKernelSingleton());

async function observe(sdk: Kernel, sessionId: string, output: string) {
  return sdk.trigger<unknown, { observationId?: string }>({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId,
      project: "demo",
      cwd: "/demo",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Grep", tool_input: { pattern: "x" }, tool_output: output },
    },
  });
}

describe("brain bundle round-trip", () => {
  let source: { sdk: Kernel; kv: StateKV };

  beforeEach(async () => {
    source = freshKernel("memwarden-export");
    await observe(source.sdk, "s1", "alpha auth module uses IAM tokens");
    await observe(source.sdk, "s2", "beta billing uses stripe webhooks");
  });

  it("exports a well-formed bundle", async () => {
    const bundle = await exportBundle(source.kv);
    expect(bundle.kind).toBe(BRAIN_BUNDLE_KIND);
    expect(isBrainBundle(bundle)).toBe(true);
    expect(bundle.sessions.length).toBe(2);
    const totalObs = Object.values(bundle.observations).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    expect(totalObs).toBe(2);
  });

  it("imports into a fresh store and memory is searchable", async () => {
    const bundle = await exportBundle(source.kv);

    const dest = freshKernel("memwarden-import");
    const counts = await importBundle(dest.kv, bundle);
    expect(counts.sessions).toBe(2);
    expect(counts.observations).toBe(2);

    // Search on the destination finds the imported memory (lazy rebuild).
    const res = await dest.sdk.trigger<unknown, { results?: Array<unknown> }>({
      function_id: "mem::search",
      payload: { query: "IAM tokens" },
    });
    expect((res.results ?? []).length).toBeGreaterThan(0);
  });

  it("rejects a non-bundle and a future version", async () => {
    expect(isBrainBundle({ kind: "nope" })).toBe(false);
    const dest = freshKernel("memwarden-import2");
    const bundle = await exportBundle(source.kv);
    await expect(
      importBundle(dest.kv, { ...bundle, version: 999 }),
    ).rejects.toThrow(/unsupported brain bundle version/);
  });
});
