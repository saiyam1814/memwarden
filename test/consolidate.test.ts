//
// mem::consolidate-pipeline — folds only deterministically equivalent claims.
// Verifies distinct same-file claims, true duplicates, mixed trust, repeated
// snapshots, legacy/imported rows, lockstep pruning, write failure, retention
// compaction, protection, project isolation, and idempotent reinforcement (#57).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV, fingerprintId } from "../src/state/schema.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { recordAccess } from "../src/functions/access-tracker.js";
import {
  BRAIN_BUNDLE_KIND,
  BRAIN_BUNDLE_VERSION,
  importBundle,
} from "../src/bundle/bundle.js";
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

async function importMemory(memory: Memory): Promise<void> {
  await importBundle(kv, {
    kind: BRAIN_BUNDLE_KIND,
    version: BRAIN_BUNDLE_VERSION,
    sessions: [],
    memories: [memory],
    observations: {},
  });
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

  it("keeps a legacy short per-file Memory beside the new claim-specific id", async () => {
    await session("s1");
    const legacyId = fingerprintId("mem", "proj-a\nsrc/auth.ts");
    const legacy: Memory = {
      id: legacyId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "fact",
      title: "Imported legacy auth note",
      content: "Legacy content must remain byte-for-byte intact.",
      concepts: ["legacy"],
      files: ["src/auth.ts"],
      sessionIds: ["legacy-session"],
      strength: 5,
      version: 7,
      sourceObservationIds: ["legacy-source"],
      isLatest: true,
      project: "proj-a",
      provenance: { files: ["src/auth.ts"], command: "legacy-import" },
    };
    await importMemory(legacy);
    for (let i = 0; i < 3; i++) await seed(obs({ id: `new-${i}` }));

    const r = await consolidate();
    expect(r.folded).toBe(3);
    expect(await kv.get<Memory>(KV.memories, legacyId)).toEqual(legacy);
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    const claim = memories.find((memory) => memory.id !== legacyId)!;
    // Legacy fingerprintId rows are mem_ + 16 hex; claim ids use all 64.
    expect(legacyId).toHaveLength(20);
    expect(claim.id).toHaveLength(68);
    expect(claim.sourceObservationIds).toHaveLength(3);
  });

  it("migrates an imported fingerprint-less row only when its identity reconstructs exactly", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `prior-${i}` }));
    await consolidate();
    const [canonical] = await kv.list<Memory>(KV.memories);
    expect(canonical).toBeDefined();

    const imported: Memory = {
      ...canonical!,
      strength: 9,
      parentId: "import-parent",
      relatedIds: ["related-memory"],
      forgetAfter: "2030-01-01T00:00:00.000Z",
      supersedes: [...(canonical!.supersedes ?? []), "legacy-superseded"],
    };
    delete imported.claimFingerprint;
    delete imported.evidenceFingerprint;
    await importMemory(imported);
    for (let i = 0; i < 3; i++) await seed(obs({ id: `later-${i}` }));

    const r = await consolidate();
    expect(r.folded).toBe(3);
    const [migrated] = await kv.list<Memory>(KV.memories);
    expect(migrated!.id).toBe(canonical!.id);
    expect(migrated!.version).toBe(2);
    expect(migrated!.claimFingerprint).toBeDefined();
    expect(migrated!.evidenceFingerprint).toBeDefined();
    expect(migrated!.sourceObservationIds).toHaveLength(6);
    expect(migrated!.supersedes).toContain("legacy-superseded");
    expect(migrated!.strength).toBe(9);
    expect(migrated!.parentId).toBe("import-parent");
    expect(migrated!.relatedIds).toEqual(["related-memory"]);
    expect(migrated!.forgetAfter).toBe("2030-01-01T00:00:00.000Z");
  });

  it("does not guess whether a fingerprint-less architecture row came from write or edit", async () => {
    await session("s1");
    const editObservation = (id: string): CompressedObservation =>
      obs({
        id,
        type: "file_edit",
        title: "Edited auth policy",
        narrative: "Refresh rotation changed to 15 minutes.",
        facts: ["rotation is 15 minutes"],
        concepts: ["auth", "rotation"],
      });
    for (let i = 0; i < 3; i++) await seed(editObservation(`prior-${i}`));
    await consolidate();
    const [canonical] = await kv.list<Memory>(KV.memories);
    expect(canonical?.type).toBe("architecture");

    const imported: Memory = { ...canonical! };
    delete imported.claimFingerprint;
    delete imported.evidenceFingerprint;
    await importMemory(imported);
    for (let i = 0; i < 3; i++) await seed(editObservation(`later-${i}`));

    const r = await consolidate();
    expect(r.folded).toBe(3);
    expect(await kv.get<Memory>(KV.memories, imported.id)).toEqual(imported);
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    expect(memories.some((memory) => memory.id.startsWith("mem_claim_"))).toBe(true);
  });

  it("preserves an incompatible imported occupant and retains the claim in a fallback Memory", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `prior-${i}` }));
    await consolidate();
    const [canonical] = await kv.list<Memory>(KV.memories);
    expect(canonical).toBeDefined();

    const imported: Memory = {
      ...canonical!,
      title: "Unrelated imported decision",
      content: "This content must never be overwritten.",
      facts: ["unrelated imported claim"],
      concepts: ["imported"],
      sourceObservationIds: ["imported-source"],
      sessionIds: ["imported-session"],
      version: 41,
    };
    delete imported.claimFingerprint;
    delete imported.evidenceFingerprint;
    await importMemory(imported);
    for (let i = 0; i < 3; i++) await seed(obs({ id: `new-${i}` }));

    const r = await consolidate();
    expect(r.consolidated).toBe(1);
    expect(r.folded).toBe(3);
    expect(await kv.get<Memory>(KV.memories, imported.id)).toEqual(imported);

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(2);
    const retained = memories.find((memory) => memory.id !== imported.id)!;
    expect(retained.id).toMatch(/^mem_claim_[a-f0-9]{64}$/);
    expect(retained.content).toContain("the file was read");
    expect(retained.sourceObservationIds).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(await kv.get(KV.observations("s1"), `new-${i}`)).toBeNull();
    }
  });

  it("refuses two incompatible imported occupants and leaves every source intact", async () => {
    await session("s1");
    for (let i = 0; i < 3; i++) await seed(obs({ id: `prior-${i}` }));
    await consolidate();
    const [canonical] = await kv.list<Memory>(KV.memories);
    expect(canonical).toBeDefined();

    const digest = canonical!.id.slice("mem_".length);
    const occupied = (id: string, label: string): Memory => {
      const memory: Memory = {
        ...canonical!,
        id,
        title: `${label} imported memory`,
        content: `${label} must survive`,
        facts: [`${label} unrelated claim`],
        sourceObservationIds: [`${label}-source`],
        version: 9,
      };
      delete memory.claimFingerprint;
      delete memory.evidenceFingerprint;
      return memory;
    };
    const primary = occupied(canonical!.id, "primary");
    const fallback = occupied(`mem_claim_${digest}`, "fallback");
    await importMemory(primary);
    await importMemory(fallback);
    for (let i = 0; i < 3; i++) await seed(obs({ id: `blocked-${i}` }));

    const r = await consolidate();
    expect(r.consolidated).toBe(0);
    expect(r.folded).toBe(0);
    expect(await kv.get<Memory>(KV.memories, primary.id)).toEqual(primary);
    expect(await kv.get<Memory>(KV.memories, fallback.id)).toEqual(fallback);
    for (let i = 0; i < 3; i++) {
      expect(await kv.get(KV.observations("s1"), `blocked-${i}`)).not.toBeNull();
    }
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
