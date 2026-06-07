//
// TurboQuant-backed vector index with VectorIndex API parity. Stores packed
// 2/4-bit codes + a per-vector norm instead of full Float32 embeddings
// (~8-16x smaller). Search is asymmetric: the query stays full precision.
// When `rescoreDepth > 0` the full vectors are retained too and the top
// candidates are re-ranked with exact cosine (best recall, no memory
// saving); with rescoreDepth 0 only codes are kept (max compression).
//
// Drop-in for the VectorIndexLike surface consumed by search.ts and
// hybrid-search.ts. Default OFF: constructed only when
// MEMWARDEN_QUANT_VECTOR=true (see makeVectorIndex in search.ts).

import {
  TURBOQUANT_VERSION,
  ROTATION_ROUNDS,
  type QuantBits,
  nextPow2,
  seedFromString,
  mulberry32,
  buildSignFlips,
  rotate,
  lloydMaxLevels,
  levelTableHash,
  encodeRotated,
  asymmetricDot,
} from "./turboquant.js";

export interface QuantParams {
  version: number;
  bits: QuantBits;
  dims: number;
  paddedDims: number;
  seed: string;
  rounds: number;
  levelHash: string;
  rescoreDepth: number;
}

interface StoredVector {
  codes: Uint8Array;
  norm: number;
  sessionId: string;
  full?: Float32Array;
}

// Same byteOffset/byteLength-guarded base64 round-trip as vector-index.ts,
// duplicated on purpose for Uint8Array: the helpers in vector-index.ts are
// load-bearing bug fixes (#455/#469/#584/#587) and stay untouched there.
function uint8ToBase64(arr: Uint8Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

function base64ToUint8(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class QuantizedVectorIndex {
  readonly params: QuantParams;
  private vectors: Map<string, StoredVector> = new Map();
  private signFlips: Int8Array[];
  private scratch: Float32Array;
  private queryScratch: Float32Array;

  constructor(opts: {
    dims: number;
    bits: QuantBits;
    seed: string;
    rescoreDepth: number;
  }) {
    const paddedDims = nextPow2(opts.dims);
    this.params = {
      version: TURBOQUANT_VERSION,
      bits: opts.bits,
      dims: opts.dims,
      paddedDims,
      seed: opts.seed,
      rounds: ROTATION_ROUNDS,
      levelHash: levelTableHash(opts.bits),
      rescoreDepth: Math.max(0, Math.floor(opts.rescoreDepth)),
    };
    this.signFlips = buildSignFlips(
      mulberry32(seedFromString(opts.seed)),
      paddedDims,
      ROTATION_ROUNDS,
    );
    this.scratch = new Float32Array(paddedDims);
    this.queryScratch = new Float32Array(paddedDims);
    // Warm the level table so first add/search doesn't pay the Lloyd cost.
    lloydMaxLevels(opts.bits);
  }

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    if (embedding.length !== this.params.dims) return; // soft-skip, guarded upstream
    const rotated = rotate(
      embedding,
      this.params.paddedDims,
      this.signFlips,
      this.scratch,
    );
    const { codes, norm } = encodeRotated(
      rotated,
      this.params.paddedDims,
      this.params.bits,
    );
    const entry: StoredVector = { codes, norm, sessionId };
    if (this.params.rescoreDepth > 0) {
      entry.full = new Float32Array(embedding);
    }
    this.vectors.set(obsId, entry);
  }

  remove(obsId: string): void {
    this.vectors.delete(obsId);
  }

  has(obsId: string): boolean {
    return this.vectors.has(obsId);
  }

  ids(): string[] {
    return Array.from(this.vectors.keys());
  }

  /**
   * Aligns the rescore setting with the current configuration after a
   * restore: the persisted blob carries the rescoreDepth it was built
   * with, which may no longer match the environment. Lowering to 0 drops
   * the retained full vectors (reclaiming memory); raising it keeps
   * working with whatever full vectors the blob had (entries without one
   * simply keep their asymmetric score — the rescore pass guards on
   * presence).
   */
  reconcileRescoreDepth(depth: number): void {
    const clamped = Math.max(0, Math.floor(depth));
    if (clamped === this.params.rescoreDepth) return;
    this.params.rescoreDepth = clamped;
    if (clamped === 0) {
      for (const entry of this.vectors.values()) {
        delete entry.full;
      }
    }
  }

  search(
    query: Float32Array,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    if (query.length !== this.params.dims || this.vectors.size === 0) {
      return [];
    }
    const D = this.params.paddedDims;
    // Dedicated query scratch: search is synchronous, so nothing else can
    // touch it before the scan below completes; `this.scratch` stays
    // reserved for add().
    const rotatedQuery = rotate(query, D, this.signFlips, this.queryScratch);
    const table = lloydMaxLevels(this.params.bits); // hoisted out of the scan
    let qNormSq = 0;
    for (let i = 0; i < D; i++) {
      const v = rotatedQuery[i] as number;
      qNormSq += v * v;
    }
    const qNorm = Math.sqrt(qNormSq);
    if (qNorm === 0) return [];
    const invScale = 1 / (Math.sqrt(D) * qNorm);

    // First pass: asymmetric scores with the same bounded top-K pattern as
    // VectorIndex.search. Pool size widens to rescoreDepth when rescoring.
    const poolSize = Math.max(limit, this.params.rescoreDepth);
    const results: Array<{ obsId: string; sessionId: string; score: number }> =
      [];
    let minScore = -Infinity;
    for (const [obsId, entry] of this.vectors) {
      const score =
        entry.norm === 0
          ? 0
          : asymmetricDot(rotatedQuery, entry.codes, D, this.params.bits, table) *
            invScale;
      if (results.length < poolSize) {
        results.push({ obsId, sessionId: entry.sessionId, score });
        if (results.length === poolSize) {
          results.sort((a, b) => a.score - b.score);
          minScore = results[0]!.score;
        }
      } else if (score > minScore) {
        results[0] = { obsId, sessionId: entry.sessionId, score };
        results.sort((a, b) => a.score - b.score);
        minScore = results[0]!.score;
      }
    }

    // Optional second pass: exact cosine on the retained full vectors.
    if (this.params.rescoreDepth > 0) {
      for (const r of results) {
        const full = this.vectors.get(r.obsId)?.full;
        if (full) r.score = cosineSimilarity(query, full);
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  get size(): number {
    return this.vectors.size;
  }

  validateDimensions(expected: number): {
    mismatches: Array<{ obsId: string; dim: number }>;
    seenDimensions: Set<number>;
  } {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    if (this.vectors.size > 0) {
      seenDimensions.add(this.params.dims);
      if (this.params.dims !== expected) {
        for (const obsId of this.vectors.keys()) {
          mismatches.push({ obsId, dim: this.params.dims });
        }
      }
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    this.vectors.clear();
  }

  restoreFrom(other: QuantizedVectorIndex): void {
    this.vectors = new Map();
    for (const [obsId, entry] of other.vectors) {
      const copy: StoredVector = {
        codes: new Uint8Array(entry.codes),
        norm: entry.norm,
        sessionId: entry.sessionId,
      };
      if (entry.full) copy.full = new Float32Array(entry.full);
      this.vectors.set(obsId, copy);
    }
  }

  serialize(): string {
    const vectors: Array<
      [string, { c: string; n: number; s: string; f?: string }]
    > = [];
    for (const [obsId, entry] of this.vectors) {
      const row: { c: string; n: number; s: string; f?: string } = {
        c: uint8ToBase64(entry.codes),
        n: entry.norm,
        s: entry.sessionId,
      };
      if (entry.full) row.f = float32ToBase64(entry.full);
      vectors.push([obsId, row]);
    }
    return JSON.stringify({ params: this.params, vectors });
  }

  /**
   * Returns null when the payload's params don't reproduce the current
   * algorithm (version, bits, seed, dims, rounds or level-table hash
   * mismatch) — the caller is expected to fall back to a full rebuild.
   */
  static deserialize(json: string): QuantizedVectorIndex | null {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
    const obj = data as {
      params?: Partial<QuantParams>;
      vectors?: unknown;
    };
    const p = obj?.params;
    if (
      !p ||
      p.version !== TURBOQUANT_VERSION ||
      (p.bits !== 2 && p.bits !== 4) ||
      typeof p.dims !== "number" ||
      typeof p.paddedDims !== "number" ||
      typeof p.seed !== "string" ||
      p.rounds !== ROTATION_ROUNDS ||
      p.paddedDims !== nextPow2(p.dims) ||
      p.levelHash !== levelTableHash(p.bits)
    ) {
      return null;
    }
    const idx = new QuantizedVectorIndex({
      dims: p.dims,
      bits: p.bits,
      seed: p.seed,
      rescoreDepth: typeof p.rescoreDepth === "number" ? p.rescoreDepth : 0,
    });
    if (!Array.isArray(obj.vectors)) return idx;
    const codesLen =
      p.bits === 4 ? Math.ceil(p.paddedDims / 2) : Math.ceil(p.paddedDims / 4);
    for (const row of obj.vectors) {
      try {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [obsId, entry] = row as [
          unknown,
          { c?: unknown; n?: unknown; s?: unknown; f?: unknown },
        ];
        if (
          typeof obsId !== "string" ||
          typeof entry?.c !== "string" ||
          typeof entry?.n !== "number" ||
          typeof entry?.s !== "string"
        )
          continue;
        const codes = base64ToUint8(entry.c);
        if (codes.length !== codesLen) continue;
        const stored: StoredVector = {
          codes,
          norm: entry.n,
          sessionId: entry.s,
        };
        if (typeof entry.f === "string") {
          const full = base64ToFloat32(entry.f);
          if (full.length === p.dims) stored.full = full;
        }
        idx.vectors.set(obsId, stored);
      } catch {
        continue;
      }
    }
    return idx;
  }
}
