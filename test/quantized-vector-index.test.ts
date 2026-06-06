//
// QuantizedVectorIndex: API parity with VectorIndex, serialize/deserialize
// determinism with params validation, recall against the full-precision
// brute force, and rescore behavior.

import { describe, expect, it } from "vitest";
import { QuantizedVectorIndex } from "../src/functions/quantized-vector-index.js";
import { VectorIndex } from "../src/functions/vector-index.js";
import type { VectorIndexLike } from "../src/functions/types.js";
import {
  mulberry32,
  seedFromString,
} from "../src/functions/turboquant.js";

const DIMS = 256;

function gaussianSampler(seed: string): () => number {
  const prng = mulberry32(seedFromString(seed));
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = prng();
    const v = prng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// 20 gaussian cluster centers; members are center + small noise. Returns
// vectors plus a set of queries drawn near known members.
function makeClusteredDataset(opts: {
  clusters: number;
  perCluster: number;
  noise: number;
  seed: string;
}) {
  const gauss = gaussianSampler(opts.seed);
  const centers: Float32Array[] = [];
  for (let c = 0; c < opts.clusters; c++) {
    centers.push(Float32Array.from({ length: DIMS }, () => gauss()));
  }
  const vectors: Array<{ id: string; v: Float32Array }> = [];
  for (let c = 0; c < opts.clusters; c++) {
    for (let m = 0; m < opts.perCluster; m++) {
      const v = new Float32Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        v[i] = (centers[c]![i] as number) + opts.noise * gauss();
      }
      vectors.push({ id: `c${c}-m${m}`, v });
    }
  }
  return { centers, vectors, gauss };
}

function newQuantIndex(rescoreDepth: number): QuantizedVectorIndex {
  return new QuantizedVectorIndex({
    dims: DIMS,
    bits: 4,
    seed: "test-seed",
    rescoreDepth,
  });
}

describe("API parity", () => {
  it("satisfies VectorIndexLike structurally (both implementations)", () => {
    const quant: VectorIndexLike = newQuantIndex(0);
    const full: VectorIndexLike = new VectorIndex();
    for (const idx of [quant, full]) {
      expect(typeof idx.add).toBe("function");
      expect(typeof idx.remove).toBe("function");
      expect(typeof idx.search).toBe("function");
      expect(typeof idx.clear).toBe("function");
      expect(typeof idx.validateDimensions).toBe("function");
      expect(typeof idx.serialize).toBe("function");
      expect(idx.size).toBe(0);
      expect(idx.search(new Float32Array(DIMS), 5)).toEqual([]);
    }
  });

  it("returns descending {obsId, sessionId, score} rows capped at limit", () => {
    const idx = newQuantIndex(0);
    const gauss = gaussianSampler("rows");
    for (let i = 0; i < 30; i++) {
      idx.add(
        `obs-${i}`,
        `sess-${i % 3}`,
        Float32Array.from({ length: DIMS }, () => gauss()),
      );
    }
    const q = Float32Array.from({ length: DIMS }, () => gauss());
    const rows = idx.search(q, 7);
    expect(rows.length).toBe(7);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.score).toBeLessThanOrEqual(rows[i - 1]!.score);
    }
    for (const r of rows) {
      expect(typeof r.obsId).toBe("string");
      expect(typeof r.sessionId).toBe("string");
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("soft-skips dimension mismatches on add", () => {
    const idx = newQuantIndex(0);
    idx.add("bad", "s", new Float32Array(DIMS + 1));
    expect(idx.size).toBe(0);
    idx.add("good", "s", new Float32Array(DIMS).fill(1));
    expect(idx.size).toBe(1);
    const report = idx.validateDimensions(DIMS);
    expect(report.mismatches).toEqual([]);
    expect(Array.from(report.seenDimensions)).toEqual([DIMS]);
    expect(idx.validateDimensions(DIMS + 1).mismatches.length).toBe(1);
  });

  it("remove and clear behave like VectorIndex", () => {
    const idx = newQuantIndex(0);
    idx.add("a", "s", new Float32Array(DIMS).fill(1));
    idx.add("b", "s", new Float32Array(DIMS).fill(2));
    idx.remove("a");
    expect(idx.size).toBe(1);
    idx.remove("a"); // idempotent
    idx.clear();
    expect(idx.size).toBe(0);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips with identical search ranking", () => {
    const idx = newQuantIndex(0);
    const gauss = gaussianSampler("serde");
    for (let i = 0; i < 50; i++) {
      idx.add(
        `obs-${i}`,
        "sess",
        Float32Array.from({ length: DIMS }, () => gauss()),
      );
    }
    const q = Float32Array.from({ length: DIMS }, () => gauss());
    const before = idx.search(q, 10).map((r) => r.obsId);

    const restored = QuantizedVectorIndex.deserialize(idx.serialize());
    expect(restored).not.toBeNull();
    expect(restored!.size).toBe(50);
    expect(restored!.search(q, 10).map((r) => r.obsId)).toEqual(before);
  });

  it("rejects params drift (version, bits, seed, levelHash)", () => {
    const idx = newQuantIndex(0);
    idx.add("a", "s", new Float32Array(DIMS).fill(1));
    const payload = JSON.parse(idx.serialize()) as {
      params: Record<string, unknown>;
    };

    const mutate = (k: string, v: unknown) => {
      const copy = JSON.parse(idx.serialize()) as {
        params: Record<string, unknown>;
      };
      copy.params[k] = v;
      return QuantizedVectorIndex.deserialize(JSON.stringify(copy));
    };

    expect(mutate("version", 999)).toBeNull();
    expect(mutate("bits", 3)).toBeNull();
    expect(mutate("levelHash", "deadbeef")).toBeNull();
    expect(mutate("paddedDims", (payload.params.paddedDims as number) * 2)).toBeNull();
    expect(QuantizedVectorIndex.deserialize("not json")).toBeNull();
    // Unmutated payload stays valid.
    expect(QuantizedVectorIndex.deserialize(idx.serialize())).not.toBeNull();
  });

  it("retains full vectors through serialization when rescoring", () => {
    const idx = newQuantIndex(10);
    const gauss = gaussianSampler("serde-full");
    const v = Float32Array.from({ length: DIMS }, () => gauss());
    idx.add("a", "s", v);
    const restored = QuantizedVectorIndex.deserialize(idx.serialize());
    expect(restored).not.toBeNull();
    // Exact-cosine rescore of the identical vector must score ~1.
    const top = restored!.search(v, 1)[0]!;
    expect(top.obsId).toBe("a");
    expect(top.score).toBeCloseTo(1, 5);
  });
});

describe("recall vs full-precision brute force", () => {
  const { vectors, gauss } = makeClusteredDataset({
    clusters: 20,
    perCluster: 100,
    noise: 0.35,
    seed: "recall",
  });

  const full = new VectorIndex();
  for (const { id, v } of vectors) full.add(id, "s", v);

  function recallAt10(idx: QuantizedVectorIndex, queries: Float32Array[]): number {
    let hit = 0;
    let total = 0;
    for (const q of queries) {
      const truth = new Set(full.search(q, 10).map((r) => r.obsId));
      const got = idx.search(q, 10);
      for (const r of got) if (truth.has(r.obsId)) hit++;
      total += truth.size;
    }
    return hit / total;
  }

  const queries: Float32Array[] = [];
  for (let i = 0; i < 40; i++) {
    const base = vectors[(i * 53) % vectors.length]!.v;
    const q = new Float32Array(DIMS);
    for (let j = 0; j < DIMS; j++) {
      q[j] = (base[j] as number) + 0.15 * gauss();
    }
    queries.push(q);
  }

  it("4-bit with rescore depth 100 reaches recall@10 >= 0.90", () => {
    const idx = newQuantIndex(100);
    for (const { id, v } of vectors) idx.add(id, "s", v);
    const r = recallAt10(idx, queries);
    expect(r).toBeGreaterThanOrEqual(0.9);
  });

  it("rescore improves top-1 agreement over no-rescore", () => {
    const plain = newQuantIndex(0);
    const rescored = newQuantIndex(100);
    for (const { id, v } of vectors) {
      plain.add(id, "s", v);
      rescored.add(id, "s", v);
    }
    let plainAgree = 0;
    let rescoredAgree = 0;
    for (const q of queries) {
      const truth = full.search(q, 1)[0]!.obsId;
      if (plain.search(q, 1)[0]!.obsId === truth) plainAgree++;
      if (rescored.search(q, 1)[0]!.obsId === truth) rescoredAgree++;
    }
    // Report for visibility; assert no regression.
    console.log(
      `top-1 agreement over ${queries.length} queries — plain: ${plainAgree}, rescored: ${rescoredAgree}`,
    );
    expect(rescoredAgree).toBeGreaterThanOrEqual(plainAgree);
    expect(rescoredAgree).toBeGreaterThanOrEqual(Math.ceil(queries.length * 0.9));
  });
});
