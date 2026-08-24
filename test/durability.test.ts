//
// THE DURABILITY CONTRACT: code-backed knowledge is distilled, never dropped.
//
// The bug this pins, measured on a real 0.0.5 install: 15,771 observations
// captured, 0 memories, and `mem::auto-forget` deleting hundreds of code-backed
// rows per hour at the TTL. Capture worked; consolidation only folded groups of
// 3+ touches of one file; everything else aged out. The layer was a sieve.
//
// These tests assert the two halves of the fix:
//   1. an expiring observation WITH file provenance is promoted into a Memory
//      (knowledge + capture-time hashes survive; the raw row is pruned)
//   2. an expiring observation WITHOUT provenance is still deleted (nothing
//      durable to promote, and unsourced text kept forever is how a store rots)
// plus the properties that make it safe: order-independence vs consolidation,
// hash fidelity (no invented provenance), and protection of important rows.

import { beforeEach, afterEach, describe, expect, it } from "vitest";
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
import type { CompressedObservation, Memory, Session } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-durability" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => {
  delete process.env["MEMWARDEN_FORGET_PROMOTE"];
  __resetKernelSingleton();
});

async function seedSession(id: string, project: string): Promise<void> {
  const session: Session = {
    id,
    project,
    cwd: project,
    startedAt: new Date(Date.now() - 60 * DAY).toISOString(),
    observationCount: 0,
  } as Session;
  await kv.set(KV.sessions, id, session);
}

/** An ordinary, long-expired, never-accessed capture — exactly what the sweep
 *  targets. `files`/`fileHashes` present unless codeBacked is false. */
async function seedObservation(opts: {
  sessionId: string;
  id: string;
  ageDays: number;
  codeBacked: boolean;
  importance?: number;
  file?: string;
}): Promise<CompressedObservation> {
  const file = opts.file ?? "src/auth.ts";
  const obs = {
    id: opts.id,
    sessionId: opts.sessionId,
    timestamp: new Date(Date.now() - opts.ageDays * DAY).toISOString(),
    type: "file_edit",
    title: `Edited ${file}`,
    narrative: "refresh tokens rotate every 15 minutes",
    facts: ["rotation is 15m"],
    concepts: ["auth", "tokens"],
    importance: opts.importance ?? 5,
    ...(opts.codeBacked
      ? {
          files: [file],
          provenance: {
            files: [file],
            fileHashes: { [file]: "a".repeat(64) },
            cwd: "/repo",
          },
        }
      : {}),
  } as unknown as CompressedObservation;
  await kv.set(KV.observations(opts.sessionId), opts.id, obs);
  return obs;
}

async function sweep(): Promise<{
  scanned: number;
  forgotten: number;
  promoted: number;
}> {
  return (await sdk.trigger({
    function_id: "mem::auto-forget",
    payload: {},
  })) as { scanned: number; forgotten: number; promoted: number };
}

describe("durability contract: code-backed knowledge is distilled, never dropped", () => {
  it("promotes an expiring code-backed observation into a memory instead of deleting it", async () => {
    await seedSession("s1", "/repo");
    await seedObservation({ sessionId: "s1", id: "obs-1", ageDays: 60, codeBacked: true });

    const r = await sweep();
    expect(r.promoted).toBe(1);
    expect(r.forgotten).toBe(0);

    // The raw row is gone (storage still shrinks)...
    expect(await kv.get(KV.observations("s1"), "obs-1")).toBeNull();
    // ...but the knowledge survives as a memory.
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain("refresh tokens rotate");
  });

  it("carries capture-time file hashes forward VERBATIM so the firewall still works", async () => {
    await seedSession("s1", "/repo");
    await seedObservation({ sessionId: "s1", id: "obs-1", ageDays: 60, codeBacked: true });

    await sweep();
    const [memory] = await kv.list<Memory>(KV.memories);
    // No synthetic hashes may ever be invented: a promoted memory must verify
    // against the live file exactly as its source observation would have.
    expect(memory!.provenance?.fileHashes?.["src/auth.ts"]).toBe("a".repeat(64));
    expect(memory!.files).toContain("src/auth.ts");
  });

  it("still deletes an expiring observation with NO provenance (nothing to promote)", async () => {
    await seedSession("s1", "/repo");
    await seedObservation({ sessionId: "s1", id: "obs-1", ageDays: 60, codeBacked: false });

    const r = await sweep();
    expect(r.forgotten).toBe(1);
    expect(r.promoted).toBe(0);
    expect(await kv.list(KV.memories)).toHaveLength(0);
    expect(await kv.get(KV.observations("s1"), "obs-1")).toBeNull();
  });

  it("leaves fresh and explicitly-important observations completely untouched", async () => {
    await seedSession("s1", "/repo");
    await seedObservation({ sessionId: "s1", id: "fresh", ageDays: 1, codeBacked: true });
    await seedObservation({
      sessionId: "s1",
      id: "important",
      ageDays: 60,
      codeBacked: true,
      importance: 8,
      file: "src/other.ts",
    });

    const r = await sweep();
    expect(r.promoted).toBe(0);
    expect(r.forgotten).toBe(0);
    expect(await kv.get(KV.observations("s1"), "fresh")).toBeTruthy();
    expect(await kv.get(KV.observations("s1"), "important")).toBeTruthy();
  });

  it("repeated touches of one file converge on a SINGLE memory (storage stays bounded)", async () => {
    await seedSession("s1", "/repo");
    for (let i = 0; i < 5; i++) {
      await seedObservation({
        sessionId: "s1",
        id: `obs-${i}`,
        ageDays: 60,
        codeBacked: true,
      });
    }

    const r = await sweep();
    expect(r.promoted).toBe(5);
    // Same (project, file) key as consolidation uses -> one memory, not five.
    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    // Every source is recorded, and reinforcement raises standing.
    expect(memories[0]!.sourceObservationIds).toHaveLength(5);
    expect(memories[0]!.strength).toBeGreaterThan(5);
  });

  it("is order-independent: sweeping BEFORE consolidation loses nothing", async () => {
    await seedSession("s1", "/repo");
    for (let i = 0; i < 4; i++) {
      await seedObservation({
        sessionId: "s1",
        id: `obs-${i}`,
        ageDays: 60,
        codeBacked: true,
      });
    }

    // The old failure raced these two timers; whichever fires first, the
    // knowledge must end up distilled.
    await sweep();
    await sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: {} });

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain("refresh tokens rotate");
  });

  it("MEMWARDEN_FORGET_PROMOTE=off restores the old delete-only behavior", async () => {
    process.env["MEMWARDEN_FORGET_PROMOTE"] = "off";
    await seedSession("s1", "/repo");
    await seedObservation({ sessionId: "s1", id: "obs-1", ageDays: 60, codeBacked: true });

    const r = await sweep();
    expect(r.forgotten).toBe(1);
    expect(r.promoted).toBe(0);
    expect(await kv.list(KV.memories)).toHaveLength(0);
  });
});
