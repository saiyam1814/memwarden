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

  // F9: retention was theater — the floor (3) sat below the capture default
  // (5), so ordinary observations NEVER expired and long-lived MCP/proxy
  // sessions marched toward the per-session observation ceiling. Honest
  // semantics: old + never-accessed + ordinary (importance <= default) is
  // sweepable; explicitly-important (>5) or accessed records are kept.
  it("sweeps old, never-accessed observations at the capture DEFAULT importance (5)", async () => {
    const ordinary = obs({
      id: "ordinary",
      importance: 5,
      timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
    });
    await seed(ordinary);
    const r = await forget(Date.now());
    expect(r.forgotten).toBe(1);
    expect(await kv.get(KV.observations("s1"), "ordinary")).toBeNull();
  });

  it("keeps explicitly-important records (importance 6, e.g. user prompts) even when old", async () => {
    await seed(
      obs({
        id: "prompt",
        importance: 6,
        timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
      }),
    );
    expect((await forget(Date.now())).forgotten).toBe(0);
    expect(await kv.get(KV.observations("s1"), "prompt")).not.toBeNull();
  });

  it("keeps old default-importance observations that were accessed", async () => {
    const accessed = obs({
      id: "used",
      importance: 5,
      timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
    });
    await seed(accessed);
    await recordAccess(kv, "used");
    expect((await forget(Date.now())).forgotten).toBe(0);
    expect(await kv.get(KV.observations("s1"), "used")).not.toBeNull();
  });

  it("keeps observations with a missing importance (never forget on bad data)", async () => {
    const noImportance = obs({
      id: "no-imp",
      timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
    });
    delete (noImportance as Partial<CompressedObservation>).importance;
    await seed(noImportance);
    expect((await forget(Date.now())).forgotten).toBe(0);
  });

  it("MEMWARDEN_FORGET_IMPORTANCE_FLOOR still tunes the sweep (at-or-below is sweepable)", async () => {
    process.env.MEMWARDEN_FORGET_IMPORTANCE_FLOOR = "2";
    try {
      const kept = obs({
        id: "kept-by-floor",
        importance: 5,
        timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
      });
      const swept = obs({
        id: "swept-by-floor",
        sessionId: "s1",
        importance: 2,
        timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
      });
      await seed(kept);
      await kv.set(KV.observations("s1"), swept.id, swept);
      getSearchIndex().add(swept);
      const r = await forget(Date.now());
      expect(r.forgotten).toBe(1);
      expect(await kv.get(KV.observations("s1"), "kept-by-floor")).not.toBeNull();
      expect(await kv.get(KV.observations("s1"), "swept-by-floor")).toBeNull();
    } finally {
      delete process.env.MEMWARDEN_FORGET_IMPORTANCE_FLOOR;
    }
  });

  it("MEMWARDEN_FORGET_TTL_DAYS still sets the retention window", async () => {
    process.env.MEMWARDEN_FORGET_TTL_DAYS = "90";
    try {
      // 60 days old: beyond the default 30-day TTL, within the 90-day one.
      await seed(
        obs({
          id: "within-ttl",
          importance: 5,
          timestamp: new Date(Date.now() - 60 * DAY).toISOString(),
        }),
      );
      expect((await forget(Date.now())).forgotten).toBe(0);
    } finally {
      delete process.env.MEMWARDEN_FORGET_TTL_DAYS;
    }
  });
});
