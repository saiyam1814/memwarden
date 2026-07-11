//
// mem::auto-forget retention sweep. Verifies the keep/forget decision and
// that forgetting stays consistent across KV, BM25, and the access log.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { recordAccess } from "../src/functions/access-tracker.js";
import type { CompressedObservation } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-forget" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => __resetKernelSingleton());

function obs(over: Partial<CompressedObservation>): CompressedObservation {
  return {
    id: "o",
    sessionId: "s1",
    timestamp: new Date().toISOString(),
    type: "tool_use" as CompressedObservation["type"],
    title: "t",
    facts: [],
    narrative: "n",
    concepts: [],
    files: [],
    importance: 1,
    ...over,
  };
}

async function seed(o: CompressedObservation): Promise<void> {
  await kv.set(KV.sessions, "s1", { id: "s1", startedAt: new Date().toISOString() });
  await kv.set(KV.observations("s1"), o.id, o);
  getSearchIndex().add(o);
}

function forget(now: number) {
  return sdk.trigger<{ now: number }, { scanned: number; forgotten: number }>({
    function_id: "mem::auto-forget",
    payload: { now },
  });
}

describe("mem::auto-forget", () => {
  it("forgets old, unimportant, never-accessed observations", async () => {
    const old = obs({
      id: "old",
      importance: 1,
      timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
    });
    await seed(old);
    const r = await forget(Date.now());
    expect(r.forgotten).toBe(1);
    expect(await kv.get(KV.observations("s1"), "old")).toBeNull();
    // BM25 dropped it too.
    expect(getSearchIndex().search("n", 5).length).toBe(0);
  });

  it("keeps recent observations", async () => {
    await seed(obs({ id: "fresh", importance: 0.1 }));
    const r = await forget(Date.now());
    expect(r.forgotten).toBe(0);
    expect(await kv.get(KV.observations("s1"), "fresh")).not.toBeNull();
  });

  it("keeps important observations even when old", async () => {
    await seed(
      obs({
        id: "important",
        importance: 9,
        timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
      }),
    );
    expect((await forget(Date.now())).forgotten).toBe(0);
  });

  it("keeps old low-importance observations that were accessed", async () => {
    const accessed = obs({
      id: "accessed",
      importance: 1,
      timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
    });
    await seed(accessed);
    await recordAccess(kv, "accessed");
    expect((await forget(Date.now())).forgotten).toBe(0);
  });

  it("never forgets on an unparseable timestamp", async () => {
    await seed(obs({ id: "bad", importance: 1, timestamp: "not-a-date" }));
    expect((await forget(Date.now())).forgotten).toBe(0);
  });
});
