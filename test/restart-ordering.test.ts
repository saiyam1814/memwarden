//
// Restart-ordering regression: after a restart, an observation that arrives
// BEFORE the first search must not hide every pre-restart memory. The cold
// rebuild used to be gated on `index.size === 0`; one early observe made the
// index non-empty and the KV walk never ran, so older memories returned zero
// results until another clean restart.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { __resetColdRebuildForTests } from "../src/functions/search.js";

let store: StoreMemory;
let sdk: Kernel;

function boot(): Kernel {
  __resetKernelSingleton();
  const k = registerWorker("in-process", { workerName: "memwarden-fn" }, { store });
  registerCoreFunctions(k, new StateKV(k));
  return k;
}

function observePayload(text: string, session: string) {
  return {
    hookType: "post_tool_use",
    sessionId: session,
    project: "proj-X",
    cwd: "/work/proj-X",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Bash",
      tool_input: { command: "true" },
      tool_output: text,
    },
  };
}

beforeEach(() => {
  store = new StoreMemory();
  getSearchIndex().clear();
  __resetColdRebuildForTests();
  sdk = boot();
});

afterEach(() => {
  __resetKernelSingleton();
});

describe("restart ordering", () => {
  it("an observe landing before the first post-restart search does not hide old memories", async () => {
    // Session 1: capture something durable.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload("raised the postgres pool max to 40 to stop timeouts", "s1"),
    });

    // "Restart": same durable store, fresh process state.
    getSearchIndex().clear();
    __resetColdRebuildForTests();
    sdk = boot();

    // A new observation arrives BEFORE anyone searches — index is now
    // non-empty, which is exactly the poisoned state for the old gate.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: observePayload("split the dashboard bundle for faster loads", "s2"),
    });
    expect(getSearchIndex().size).toBeGreaterThan(0);

    // The pre-restart memory must still be findable.
    const res = await sdk.trigger<unknown, { results: Array<{ obsId: string }> }>({
      function_id: "mem::search",
      payload: { query: "postgres pool timeouts" },
    });
    expect(res!.results.length).toBeGreaterThan(0);
  });
});
