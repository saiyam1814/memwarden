//
// Batched cold rebuild: rebuildIndex must embed missing docs through the
// provider's embedBatch in EMBED_BATCH_SIZE chunks — not one embed() call
// per doc — while preserving every prior semantic: incremental-sync mode
// (restored vectors are not re-embedded), ghost eviction, and the guarded
// soft-fail contract (a failing chunk falls back to per-doc adds; a bad
// dimension skips only that row).

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
  setVectorIndex,
  getVectorIndex,
  setEmbeddingProvider,
  rebuildIndex,
} from "../src/functions/index.js";
import { EMBED_BATCH_SIZE } from "../src/functions/search.js";
import { VectorIndex } from "../src/functions/vector-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Session,
} from "../src/functions/types.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

const DIMS = 32;

/** Deterministic hash-direction embeddings + call counters. */
function makeCountingProvider(opts?: {
  failBatch?: boolean;
  failEmbedFor?: (text: string) => boolean;
  badDimsFor?: (text: string) => boolean;
  shortBatch?: boolean;
}): EmbeddingProvider & {
  embedCalls: number;
  embedBatchCalls: number;
  embedBatchDocs: number;
} {
  const embedSync = (text: string): Float32Array => {
    const prng = mulberry32(seedFromString(text));
    return Float32Array.from({ length: DIMS }, () => prng() - 0.5);
  };
  const provider = {
    name: "counting-stub",
    dimensions: DIMS,
    embedCalls: 0,
    embedBatchCalls: 0,
    embedBatchDocs: 0,
    embed(text: string): Promise<Float32Array> {
      provider.embedCalls++;
      if (opts?.failEmbedFor?.(text)) {
        return Promise.reject(new Error("embed refused: " + text));
      }
      return Promise.resolve(embedSync(text));
    },
    embedBatch(texts: string[]): Promise<Float32Array[]> {
      provider.embedBatchCalls++;
      provider.embedBatchDocs += texts.length;
      if (opts?.failBatch) return Promise.reject(new Error("batch down"));
      if (opts?.shortBatch) {
        return Promise.resolve(texts.slice(1).map(embedSync));
      }
      return Promise.resolve(
        texts.map((t) =>
          opts?.badDimsFor?.(t) ? new Float32Array(DIMS + 1) : embedSync(t),
        ),
      );
    },
  };
  return provider;
}

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-rb" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  setVectorIndex(null);
  setEmbeddingProvider(null);
  __resetKernelSingleton();
});

function session(id: string): Session {
  return {
    id,
    project: "/proj",
    cwd: "/proj",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
  };
}

function obs(id: string, sessionId: string, i: number): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "discovery",
    title: `doc ${i} title`,
    facts: [`fact ${i}`],
    narrative: `narrative body for doc ${i}`,
    concepts: [],
    files: [],
    importance: 0.5,
  };
}

async function seedDocs(count: number, sessionId = "s-batch"): Promise<void> {
  await kv.set(KV.sessions, sessionId, session(sessionId));
  for (let i = 0; i < count; i++) {
    await kv.set(KV.observations(sessionId), `obs-${i}`, obs(`obs-${i}`, sessionId, i));
  }
}

describe("batched cold rebuild", () => {
  it("embeds via embedBatch in chunks instead of one embed() per doc", async () => {
    const N = 150; // 3 chunks at EMBED_BATCH_SIZE=64
    await seedDocs(N);
    const provider = makeCountingProvider();
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());

    const count = await rebuildIndex(kv);

    expect(count).toBe(N);
    expect(getVectorIndex()!.size).toBe(N);
    expect(provider.embedBatchCalls).toBe(Math.ceil(N / EMBED_BATCH_SIZE));
    expect(provider.embedBatchDocs).toBe(N);
    expect(provider.embedCalls).toBe(0); // no per-doc round-trips
  });

  it("incremental sync: already-restored vectors are not re-embedded; ghosts evicted", async () => {
    await seedDocs(10);
    const provider = makeCountingProvider();
    setEmbeddingProvider(provider);
    const vIdx = new VectorIndex();
    setVectorIndex(vIdx);
    // Simulate a restored blob: 4 docs already present + one ghost.
    for (let i = 0; i < 4; i++) {
      vIdx.add(`obs-${i}`, "s-batch", await provider.embed(`restored ${i}`));
    }
    vIdx.add("ghost-1", "s-batch", await provider.embed("ghost"));
    provider.embedCalls = 0;

    await rebuildIndex(kv, { preserveVectorIndex: true });

    expect(vIdx.has("ghost-1")).toBe(false); // ghost evicted
    for (let i = 0; i < 10; i++) expect(vIdx.has(`obs-${i}`)).toBe(true);
    // Only the 6 missing docs were embedded, in one batch call.
    expect(provider.embedBatchDocs).toBe(6);
    expect(provider.embedCalls).toBe(0);
  });

  it("a failing embedBatch chunk falls back to per-doc guarded adds (one bad doc skips only itself)", async () => {
    await seedDocs(5);
    const provider = makeCountingProvider({
      failBatch: true,
      failEmbedFor: (text) => text.includes("doc 2"),
    });
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());

    const count = await rebuildIndex(kv);

    expect(count).toBe(5); // BM25 count is unaffected by vector soft-fails
    const vIdx = getVectorIndex()!;
    expect(vIdx.has("obs-2")).toBe(false); // the one bad doc
    expect(vIdx.size).toBe(4); // its 4 healthy neighbors survived
    expect(provider.embedCalls).toBe(5); // per-doc fallback engaged
  });

  it("a row-count mismatch from embedBatch falls back to per-doc adds", async () => {
    await seedDocs(3);
    const provider = makeCountingProvider({ shortBatch: true });
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv);

    expect(getVectorIndex()!.size).toBe(3);
    expect(provider.embedCalls).toBe(3);
  });

  it("a dimension-mismatched row is skipped without harming the rest of its chunk", async () => {
    await seedDocs(5);
    const provider = makeCountingProvider({
      badDimsFor: (text) => text.includes("doc 3"),
    });
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv);

    const vIdx = getVectorIndex()!;
    expect(vIdx.has("obs-3")).toBe(false);
    expect(vIdx.size).toBe(4);
    expect(provider.embedCalls).toBe(0); // no fallback needed
  });

  it("no provider configured: rebuild indexes BM25 and leaves vectors empty", async () => {
    await seedDocs(4);
    setVectorIndex(new VectorIndex());
    const count = await rebuildIndex(kv);
    expect(count).toBe(4);
    expect(getVectorIndex()!.size).toBe(0);
    expect(getSearchIndex().size).toBe(4);
  });
});
