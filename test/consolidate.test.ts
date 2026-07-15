//
// mem::consolidate-pipeline — distills duplicate file-backed observations into
// one canonical Memory (#20). Verifies the collapse, lockstep pruning across
// KV + BM25, the firewall-preserving provenance carry-forward, the protection
// of important/accessed observations, the sub-threshold skip, and versioning.

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
import type { CompressedObservation, Memory } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-consolidate" }, {
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
    type: "file_read",
    title: "read auth.ts",
    facts: [],
    narrative: "the file was read",
    concepts: [],
    files: ["src/auth.ts"],
    importance: 5, // capture default -> foldable (floor is 5, > is protected)
    ...over,
  };
}

async function session(id: string, project = "proj-a"): Promise<void> {
  await kv.set(KV.sessions, id, {
    id,
    project,
    startedAt: new Date().toISOString(),
  });
}

async function seed(o: CompressedObservation): Promise<void> {
  await kv.set(KV.observations(o.sessionId), o.id, o);
  getSearchIndex().add(o);
}

function consolidate(now = Date.now()) {
  return sdk.trigger<
    { now: number },
    { scannedGroups: number; consolidated: number; folded: number; protectedKept: number }
  >({ function_id: "mem::consolidate-pipeline", payload: { now } });
}

describe("mem::consolidate-pipeline", () => {
  it("collapses N duplicate file observations into ONE memory and prunes the sources", async () => {
    await session("s1");
    for (let i = 0; i < 5; i++) {
      await seed(
        obs({
          id: `read-${i}`,
          narrative: `read number ${i} of auth.ts`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        }),
      );
    }

    const r = await consolidate();
    expect(r.consolidated).toBe(1);
    expect(r.folded).toBe(5);

    // Exactly one memory now exists (was 0 before).
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories.length).toBe(1);
    expect(memories[0]!.files).toContain("src/auth.ts");
    expect(memories[0]!.sourceObservationIds).toHaveLength(5);
    expect(memories[0]!.isLatest).toBe(true);

    // All five source observations are gone from KV.
    for (let i = 0; i < 5; i++) {
      expect(await kv.get(KV.observations("s1"), `read-${i}`)).toBeNull();
    }

    // BM25 dropped the raw observations; the memory is searchable in their place.
    const idx = getSearchIndex();
    const idsFor = (q: string) => idx.search(q, 5).map((h) => h.obsId);
    expect(idsFor("read number 0")).not.toContain("read-0");
    expect(idsFor(memories[0]!.content)).toContain(memories[0]!.id);
  });

  it("carries the NEWEST observation's provenance forward verbatim (firewall preserved)", async () => {
    await session("s1");
    // Older rows: no hashes. Newest: real capture-time hashes.
    await seed(obs({ id: "r1", timestamp: new Date(Date.now()).toISOString() }));
    await seed(obs({ id: "r2", timestamp: new Date(Date.now() + 1000).toISOString() }));
    const newestProv = {
      files: ["src/auth.ts"],
      fileHashes: { "src/auth.ts": "abc123deadbeef" },
      command: "Read",
      capturedAt: new Date(Date.now() + 2000).toISOString(),
    };
    await seed(
      obs({
        id: "r3-newest",
        narrative: "the current truth about auth.ts",
        timestamp: new Date(Date.now() + 2000).toISOString(),
        provenance: newestProv,
      }),
    );

    await consolidate();
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    // The memory verifies against the live file exactly as the newest source
    // would: it inherits that provenance (files + hashes) verbatim.
    expect(memories[0]!.provenance?.fileHashes).toEqual(newestProv.fileHashes);
    expect(memories[0]!.content).toBe("the current truth about auth.ts");
  });

  it("never invents hashes: an all-hashless (adopted-style) group yields a hashless memory", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `adopted-${i}`,
          provenance: { files: ["src/auth.ts"], command: "adopt" }, // no fileHashes
        }),
      );
    }
    await consolidate();
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    // No hashes present -> can never be laundered into `verified`.
    expect(memories[0]!.provenance?.fileHashes).toBeUndefined();
  });

  it("protects important observations: never folded, never deleted", async () => {
    await session("s1");
    // 3 ordinary (foldable) + 1 important for the same file.
    for (let i = 0; i < 3; i++) await seed(obs({ id: `ord-${i}` }));
    await seed(obs({ id: "vip", importance: 9 }));

    const r = await consolidate();
    expect(r.consolidated).toBe(1);
    expect(r.folded).toBe(3); // only the 3 ordinary ones
    expect(await kv.get(KV.observations("s1"), "vip")).not.toBeNull();
  });

  it("protects accessed observations even at default importance", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `ord-${i}` }));
    await seed(obs({ id: "used" }));
    await recordAccess(kv, "used");

    const r = await consolidate();
    expect(r.folded).toBe(3);
    expect(await kv.get(KV.observations("s1"), "used")).not.toBeNull();
  });

  it("leaves sub-threshold groups untouched (default min-group is 3)", async () => {
    await session("s1");
    await seed(obs({ id: "a" }));
    await seed(obs({ id: "b" }));

    const r = await consolidate();
    expect(r.consolidated).toBe(0);
    expect((await kv.list<Memory>(KV.memories)).length).toBe(0);
    expect(await kv.get(KV.observations("s1"), "a")).not.toBeNull();
    expect(await kv.get(KV.observations("s1"), "b")).not.toBeNull();
  });

  it("does not consolidate non-file observation types", async () => {
    await session("s1");
    for (let i = 0; i < 4; i++) {
      await seed(
        obs({
          id: `conv-${i}`,
          type: "conversation",
          files: [],
          provenance: undefined,
        }),
      );
    }
    const r = await consolidate();
    expect(r.consolidated).toBe(0);
    expect((await kv.list<Memory>(KV.memories)).length).toBe(0);
  });

  it("is idempotent per (project,file) and versions on re-run with new observations", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `first-${i}` }));
    await consolidate();
    const afterFirst = await kv.list<Memory>(KV.memories);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.version).toBe(1);
    const memId = afterFirst[0]!.id;

    // New activity on the same file after the first sweep.
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `second-${i}`,
          narrative: `later read ${i}`,
          timestamp: new Date(Date.now() + 10000).toISOString(),
        }),
      );
    }
    await consolidate(Date.now() + 20000);

    const afterSecond = await kv.list<Memory>(KV.memories);
    // Still one memory for the file, same id, version bumped (no duplication).
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(memId);
    expect(afterSecond[0]!.version).toBe(2);
  });

  it("records a retention score for each consolidated memory", async () => {
    await session("s1");
    for (let i = 0; i < 4; i++) await seed(obs({ id: `r-${i}` }));
    await consolidate();
    const scores = await kv.list<{ memoryId: string; folded: number }>(
      KV.retentionScores,
    );
    expect(scores.length).toBe(1);
    expect(scores[0]!.folded).toBe(4);
  });

  it("keys by project: same file in two projects stays two memories", async () => {
    await session("s1", "proj-a");
    await session("s2", "proj-b");
    for (let i = 0; i < 3; i++)
      await seed(obs({ id: `a-${i}`, sessionId: "s1" }));
    for (let i = 0; i < 3; i++)
      await seed(obs({ id: `b-${i}`, sessionId: "s2" }));

    const r = await consolidate();
    expect(r.consolidated).toBe(2);
    expect((await kv.list<Memory>(KV.memories)).length).toBe(2);
  });
});
