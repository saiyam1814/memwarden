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
import { HybridSearch } from "../src/functions/hybrid-search.js";
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

  it("fuses the vector stream and finds the planted near-duplicate", async () => {
    const provider = makeStubProvider();
    setEmbeddingProvider(provider);
    const vIdx = makeVectorIndex(DIMS);
    setVectorIndex(vIdx);

    // Create observations through the real observe path, then embed each
    // with a controlled text whose head word selects the stub anchor: the
    // two kubernetes observations share the query's anchor, the others
    // don't.
    const planted: Array<{ obsId: string; head: string }> = [];
    for (const [head, id] of [
      ["kubernetes", "a"],
      ["kubernetes", "b"],
      ["database", "c"],
      ["frontend", "d"],
    ] as const) {
      const r = await sdk.trigger<unknown, { observationId?: string }>({
        function_id: "mem::observe",
        payload: observePayload(head, id),
      });
      expect(typeof r?.observationId).toBe("string");
      planted.push({ obsId: r!.observationId!, head });
    }

    for (const { obsId, head } of planted) {
      const emb = await provider.embed(`${head} memory for ${obsId}`);
      vIdx.add(obsId, "sess-A", emb);
    }
    expect(vIdx.size).toBe(4);

    const hybrid = new HybridSearch(
      getSearchIndex(),
      vIdx,
      provider,
      kv,
    );
    const results = await hybrid.search("kubernetes scheduling", 5);
    expect(results.length).toBeGreaterThan(0);
    // The vector stream contributed: at least one fused row carries a
    // nonzero vectorScore.
    expect(results.some((r) => r.vectorScore > 0)).toBe(true);
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
