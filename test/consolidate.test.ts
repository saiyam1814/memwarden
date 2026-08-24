//
// mem::consolidate-pipeline — folds only deterministically equivalent claims.
// Verifies distinct same-file claims, true duplicates, mixed trust, repeated
// snapshots, lockstep pruning, write failure, retention compaction, protection,
// project isolation, and idempotent reinforcement (#57).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let store: StoreMemory;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  store = new StoreMemory();
  sdk = registerWorker("in-process", { workerName: "memwarden-consolidate" }, {
    store,
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetKernelSingleton();
});

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
  it("keeps three distinct auth claims in one file independently searchable", async () => {
    await session("s1");
    const claims = [
      ["rotation", "Refresh tokens rotate every 15 minutes."],
      ["revocation", "Password changes revoke all refresh tokens."],
      ["rate-limit", "Failed refreshes are rate-limited by account."],
    ] as const;
    for (const [id, claim] of claims) {
      await seed(
        obs({
          id,
          title: claim,
          narrative: claim,
          facts: [claim],
          concepts: [id],
        }),
      );
    }

    const r = await consolidate();
    expect(r.scannedGroups).toBe(1);
    expect(r.consolidated).toBe(0);
    expect(r.folded).toBe(0);
    expect(await kv.list(KV.memories)).toHaveLength(0);

    for (const [id, claim] of claims) {
      expect(await kv.get(KV.observations("s1"), id)).not.toBeNull();
      expect(getSearchIndex().search(claim, 5).map((hit) => hit.obsId)).toContain(id);
    }
  });

  it("collapses true/whitespace-equivalent duplicates into ONE memory and prunes the sources", async () => {
    await session("s1");
    for (let i = 0; i < 5; i++) {
      await seed(
        obs({
          id: `read-${i}`,
          title: "Refresh token rotation",
          narrative:
            i % 2 === 0
              ? "Refresh tokens rotate every 15 minutes."
              : "Refresh   tokens rotate every 15 minutes.",
          facts: ["Rotation is 15 minutes"],
          concepts: ["auth", "tokens"],
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
    expect(memories[0]!.facts).toEqual(["Rotation is 15 minutes"]);
    expect(memories[0]!.isLatest).toBe(true);

    // All five source observations are gone from KV.
    for (let i = 0; i < 5; i++) {
      expect(await kv.get(KV.observations("s1"), `read-${i}`)).toBeNull();
    }

    // BM25 dropped the raw observations; the memory is searchable in their place.
    const idx = getSearchIndex();
    const idsFor = (q: string) => idx.search(q, 5).map((h) => h.obsId);
    expect(idsFor("Refresh token rotation")).not.toContain("read-0");
    expect(idsFor("Refresh token rotation")).toContain(memories[0]!.id);
  });

  it("carries equivalent evidence's NEWEST provenance forward verbatim", async () => {
    await session("s1");
    const base = Date.now();
    const provenanceAt = (offset: number) => ({
      files: ["src/auth.ts"],
      fileHashes: { "src/auth.ts": "abc123deadbeef" },
      command: "Read",
      capturedAt: new Date(base + offset).toISOString(),
    });
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: i === 2 ? "r3-newest" : `r${i + 1}`,
          title: "Current auth policy",
          narrative: "Refresh tokens rotate every 15 minutes.",
          timestamp: new Date(base + i * 1000).toISOString(),
          provenance: provenanceAt(i * 1000),
        }),
      );
    }
    const newestProv = provenanceAt(2000);

    await consolidate();
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.provenance).toEqual(newestProv);
    expect(memories[0]!.content).toContain("Refresh tokens rotate");
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

  it("keeps mixed-trust evidence in separate memories instead of laundering it", async () => {
    await session("s1");
    const hash = "f".repeat(64);
    for (const trust of ["verified", "mixed"] as const) {
      for (let i = 0; i < 3; i++) {
        await seed(
          obs({
            id: `${trust}-${i}`,
            title: "Refresh policy",
            narrative: "Refresh tokens rotate every 15 minutes.",
            provenance: {
              files: ["src/auth.ts"],
              fileHashes: { "src/auth.ts": hash },
              command: "Read",
              ...(trust === "mixed" ? { mixedTrust: true } : {}),
            },
          }),
        );
      }
    }

    const r = await consolidate();
    expect(r.consolidated).toBe(2);
    expect(r.folded).toBe(6);
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    expect(memories.map((memory) => memory.provenance?.mixedTrust)).toEqual(
      expect.arrayContaining([undefined, true]),
    );
    for (const memory of memories) {
      expect(memory.provenance?.fileHashes?.["src/auth.ts"]).toBe(hash);
      expect(memory.sourceObservationIds).toHaveLength(3);
    }
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

  it("is idempotent per claim/evidence identity and reinforces true duplicates", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `first-${i}` }));
    await consolidate();
    const afterFirst = await kv.list<Memory>(KV.memories);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.version).toBe(1);
    const memId = afterFirst[0]!.id;

    // New equivalent support after the first sweep.
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `second-${i}`,
          timestamp: new Date(Date.now() + 10000 + i).toISOString(),
        }),
      );
    }
    await consolidate(Date.now() + 20000);

    const afterSecond = await kv.list<Memory>(KV.memories);
    // Still one memory for this claim, same id, version bumped (no duplication).
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.id).toBe(memId);
    expect(afterSecond[0]!.version).toBe(2);
    expect(afterSecond[0]!.sourceObservationIds).toHaveLength(6);
    expect(afterSecond[0]!.content).toContain("the file was read");
  });

  it("preserves repeated file versions as separate claim/evidence memories", async () => {
    await session("s1");
    const versions = [
      {
        name: "v1",
        hash: "1".repeat(64),
        claim: "Refresh tokens rotate every 15 minutes.",
      },
      {
        name: "v2",
        hash: "2".repeat(64),
        claim: "Refresh tokens rotate every 30 minutes.",
      },
    ] as const;

    for (const [versionIndex, version] of versions.entries()) {
      for (let i = 0; i < 3; i++) {
        await seed(
          obs({
            id: `${version.name}-${i}`,
            title: "Refresh token rotation",
            narrative: version.claim,
            facts: [version.claim],
            timestamp: new Date(Date.now() + versionIndex * 10_000 + i).toISOString(),
            provenance: {
              files: ["src/auth.ts"],
              fileHashes: { "src/auth.ts": version.hash },
              command: "Read",
            },
          }),
        );
      }
      await consolidate(Date.now() + versionIndex * 20_000);
    }

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    for (const version of versions) {
      const memory = memories.find((candidate) => candidate.content.includes(version.claim));
      expect(memory).toBeDefined();
      expect(memory!.provenance?.fileHashes?.["src/auth.ts"]).toBe(version.hash);
      expect(memory!.sourceObservationIds).toHaveLength(3);
      expect(getSearchIndex().search(version.claim, 5).map((hit) => hit.obsId)).toContain(
        memory!.id,
      );
    }
  });

  it("keeps the previous memory and every source when successor installation fails", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `prior-${i}` }));
    await consolidate();
    const [before] = await kv.list<Memory>(KV.memories);
    expect(before?.version).toBe(1);

    for (let i = 0; i < 3; i++) await seed(obs({ id: `source-${i}` }));
    const originalSet = kv.set.bind(kv);
    vi.spyOn(kv, "set").mockImplementation(async (scope, key, value) => {
      if (scope === KV.memories) throw new Error("simulated write failure");
      return originalSet(scope, key, value);
    });

    const r = await consolidate();
    expect(r.consolidated).toBe(0);
    expect(r.folded).toBe(0);
    expect(await kv.list<Memory>(KV.memories)).toEqual([before]);
    for (let i = 0; i < 3; i++) {
      expect(await kv.get(KV.observations("s1"), `source-${i}`)).not.toBeNull();
      expect(getSearchIndex().has(`source-${i}`)).toBe(true);
    }
  });

  it("survives retention-history compaction after reinforcement and distinct claims", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `rotation-a-${i}`,
          title: "Refresh rotation",
          narrative: "Refresh tokens rotate every 15 minutes.",
        }),
      );
    }
    await consolidate(Date.now());

    // Rewriting the same claim produces a superseded payload for one live key.
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `rotation-b-${i}`,
          title: "Refresh rotation",
          narrative: "Refresh tokens rotate every 15 minutes.",
        }),
      );
    }
    await consolidate(Date.now() + 10_000);

    // A different claim in the file is a different live key, not a new version
    // of the rotation memory.
    for (let i = 0; i < 3; i++) {
      await seed(
        obs({
          id: `revocation-${i}`,
          title: "Password revocation",
          narrative: "Password changes revoke all refresh tokens.",
        }),
      );
    }
    await consolidate(Date.now() + 20_000);

    const compacted = await store.compactOplog({ pruneSuperseded: true });
    expect(compacted.prunedCount).toBeGreaterThan(0);
    expect(await store.verifyOplog()).toEqual({ ok: true });

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    expect(memories.map((memory) => memory.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rotate every 15 minutes"),
        expect.stringContaining("revoke all refresh tokens"),
      ]),
    );
    const rotation = memories.find((memory) => memory.title === "Refresh rotation");
    expect(rotation?.version).toBe(2);
    expect(rotation?.sourceObservationIds).toHaveLength(6);
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
