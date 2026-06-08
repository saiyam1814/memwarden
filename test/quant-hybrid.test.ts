//
// Integration: with MEMWARDEN_QUANT_VECTOR=true and a stub embedding
// provider, the HybridSearch vector stream lights up through the
// QuantizedVectorIndex with zero changes to the fusion code, and the
// persistence round-trip restores the index.

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
  makeVectorIndex,
  persistVectorIndex,
  loadVectorIndex,
  QuantizedVectorIndex,
} from "../src/functions/index.js";
import type { EmbeddingProvider } from "../src/functions/types.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

const DIMS = 64;

// Deterministic "embeddings": a few known phrases map to fixed anchors;
// anything else hashes to a pseudo-random direction. Near-duplicate text
// shares its anchor with small noise, giving real cosine structure.
function makeStubProvider(): EmbeddingProvider {
  const anchors = new Map<string, Float32Array>();
  const anchorFor = (key: string): Float32Array => {
    let a = anchors.get(key);
    if (!a) {
      const prng = mulberry32(seedFromString(`anchor:${key}`));
      a = Float32Array.from({ length: DIMS }, () => prng() - 0.5);
      anchors.set(key, a);
    }
    return a;
  };
  const embedSync = (text: string): Float32Array => {
    const head = text.trim().split(/\s+/)[0] ?? "";
    const base = anchorFor(head);
    const prng = mulberry32(seedFromString(`noise:${text}`));
    return Float32Array.from(
      base,
      (v) => v + 0.02 * (prng() - 0.5),
    );
  };
  return {
    name: "stub",
    dimensions: DIMS,
    embed: (text) => Promise.resolve(embedSync(text)),
    embedBatch: (texts) => Promise.resolve(texts.map(embedSync)),
  };
}

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  process.env.MEMWARDEN_QUANT_VECTOR = "true";
  process.env.MEMWARDEN_QUANT_BITS = "4";
  process.env.MEMWARDEN_QUANT_RESCORE = "16";
  __resetKernelSingleton();
  getSearchIndex().clear();
  const store = new StoreMemory();
  sdk = registerWorker("in-process", { workerName: "memwarden-fn" }, { store });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  delete process.env.MEMWARDEN_QUANT_VECTOR;
  delete process.env.MEMWARDEN_QUANT_BITS;
  delete process.env.MEMWARDEN_QUANT_RESCORE;
  setVectorIndex(null);
  setEmbeddingProvider(null);
  __resetKernelSingleton();
});

function observePayload(narrativeHead: string, id: string) {
  return {
    hookType: "post_tool_use",
    sessionId: "sess-A",
    project: "proj-X",
    cwd: "/work/proj-X",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Grep",
      tool_input: { pattern: narrativeHead, path: `src/${id}.ts` },
      tool_output: `${narrativeHead} relevant output for ${id}`,
    },
  };
}

describe("quantized vector stream in hybrid fusion", () => {
  it("makeVectorIndex returns the quantized implementation under the flag", () => {
    const idx = makeVectorIndex(DIMS);
    expect(idx).toBeInstanceOf(QuantizedVectorIndex);
  });

  it("restore + rebuild runs incremental sync: embeds missing docs, evicts ghosts", async () => {
    const provider = makeStubProvider();
    setEmbeddingProvider(provider);
    const vIdx = makeVectorIndex(DIMS) as QuantizedVectorIndex;
    setVectorIndex(vIdx);

    // One real observation, embedded and persisted alongside a ghost entry
    // that exists only in the blob (simulates a doc deleted after persist).
    const r1 = await sdk.trigger<unknown, { observationId?: string }>({
      function_id: "mem::observe",
      payload: observePayload("kubernetes", "live"),
    });
    const liveId = r1!.observationId!;
    vIdx.add(liveId, "sess-A", await provider.embed("kubernetes live doc"));
    vIdx.add("ghost-1", "sess-A", await provider.embed("database ghost doc"));
    expect(await persistVectorIndex(kv)).toBe(true);

    // A second observation lands AFTER the persist — the blob doesn't have it.
    const r2 = await sdk.trigger<unknown, { observationId?: string }>({
      function_id: "mem::observe",
      payload: observePayload("frontend", "late"),
    });
    const lateId = r2!.observationId!;

    // Cold start: restore the blob, then rebuild in incremental-sync mode.
    setVectorIndex(null);
    getSearchIndex().clear();
    expect(await loadVectorIndex(kv)).toBe(true);
    const { rebuildIndex } = await import("../src/functions/search.js");
    await rebuildIndex(kv, { preserveVectorIndex: true });

    const synced = getVectorIndex()!;
    expect(synced.has(liveId)).toBe(true); // restored, not re-embedded
    expect(synced.has(lateId)).toBe(true); // missing doc embedded during sync
    expect(synced.has("ghost-1")).toBe(false); // ghost evicted

    // Persisting again converges the blob with KV.
    expect(await persistVectorIndex(kv)).toBe(true);
    setVectorIndex(null);
    expect(await loadVectorIndex(kv)).toBe(true);
    expect(getVectorIndex()!.has("ghost-1")).toBe(false);
    expect(getVectorIndex()!.size).toBe(2);
  });

  it("loadVectorIndex reconciles rescore depth with the environment", async () => {
    const provider = makeStubProvider();
    setEmbeddingProvider(provider);
    // Built and persisted with rescore 16 (env from beforeEach).
    const vIdx = makeVectorIndex(DIMS) as QuantizedVectorIndex;
    setVectorIndex(vIdx);
    vIdx.add("obs-1", "sess-A", await provider.embed("kubernetes pods"));
    expect(vIdx.params.rescoreDepth).toBe(16);
    expect(await persistVectorIndex(kv)).toBe(true);

    // Environment now says no rescore: the restored index must follow and
    // drop the retained full vectors.
    process.env.MEMWARDEN_QUANT_RESCORE = "0";
    setVectorIndex(null);
    expect(await loadVectorIndex(kv)).toBe(true);
    const restored = getVectorIndex() as QuantizedVectorIndex;
    expect(restored.params.rescoreDepth).toBe(0);
    expect(restored.serialize()).not.toContain('"f":');
  });

  it("persists and restores the quantized index through KV", async () => {
    const provider = makeStubProvider();
    setEmbeddingProvider(provider);
    const vIdx = makeVectorIndex(DIMS) as QuantizedVectorIndex;
    setVectorIndex(vIdx);
    vIdx.add("obs-1", "sess-A", await provider.embed("kubernetes pods"));
    vIdx.add("obs-2", "sess-A", await provider.embed("database tables"));

    expect(await persistVectorIndex(kv)).toBe(true);

    setVectorIndex(null);
    expect(await loadVectorIndex(kv)).toBe(true);
    const restored = getVectorIndex();
    expect(restored).toBeInstanceOf(QuantizedVectorIndex);
    expect(restored!.size).toBe(2);

    const q = await provider.embed("kubernetes cluster");
    const rows = restored!.search(q, 1);
    expect(rows[0]!.obsId).toBe("obs-1");
  });
});
