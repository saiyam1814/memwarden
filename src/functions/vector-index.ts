//
// Flat brute-force cosine vector index: the full-precision baseline behind the
// VectorIndexLike contract (QuantizedVectorIndex is the compressed default).
// Pure and engine-independent.
//
// The base64 helpers pass byteOffset + byteLength explicitly on purpose:
// Buffer.from(b64, "base64") hands back a slice of Node's shared pool, and a
// naive `new Float32Array(buf.buffer)` would mint a view over the whole pool
// (phantom dimensions). The same care applies on encode if the source array is
// itself a view. Keep these exact.

function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface Entry {
  embedding: Float32Array;
  sessionId: string;
}

export interface VectorHit {
  obsId: string;
  sessionId: string;
  score: number;
}

export class VectorIndex {
  private vectors = new Map<string, Entry>();

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.vectors.set(obsId, { embedding, sessionId });
  }

  remove(obsId: string): void {
    this.vectors.delete(obsId);
  }

  has(obsId: string): boolean {
    return this.vectors.has(obsId);
  }

  ids(): string[] {
    return [...this.vectors.keys()];
  }

  get size(): number {
    return this.vectors.size;
  }

  search(query: Float32Array, limit = 20): VectorHit[] {
    const scored: VectorHit[] = [];
    for (const [obsId, entry] of this.vectors) {
      scored.push({ obsId, sessionId: entry.sessionId, score: cosine(query, entry.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return limit < scored.length ? scored.slice(0, limit) : scored;
  }

  // Reports any stored vectors whose dimension differs from `expected`, plus
  // the distinct dimensions seen. The persistence guard refuses to load an
  // index with mismatches; the only clean state is no mismatches and a single
  // seen dimension equal to `expected`.
  validateDimensions(expected: number): {
    mismatches: Array<{ obsId: string; dim: number }>;
    seenDimensions: Set<number>;
  } {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    for (const [obsId, entry] of this.vectors) {
      const dim = entry.embedding.length;
      seenDimensions.add(dim);
      if (dim !== expected) mismatches.push({ obsId, dim });
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    this.vectors.clear();
  }

  restoreFrom(other: VectorIndex): void {
    this.vectors = new Map();
    for (const [obsId, entry] of other.vectors) {
      this.vectors.set(obsId, {
        embedding: new Float32Array(entry.embedding),
        sessionId: entry.sessionId,
      });
    }
  }

  serialize(): string {
    const rows: Array<[string, { embedding: string; sessionId: string }]> = [];
    for (const [obsId, entry] of this.vectors) {
      rows.push([obsId, { embedding: float32ToBase64(entry.embedding), sessionId: entry.sessionId }]);
    }
    return JSON.stringify(rows);
  }

  static deserialize(json: string): VectorIndex {
    const idx = new VectorIndex();
    let rows: unknown;
    try {
      rows = JSON.parse(json);
    } catch {
      return idx;
    }
    if (!Array.isArray(rows)) return idx;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [obsId, entry] = row as [
        unknown,
        { embedding?: unknown; sessionId?: unknown },
      ];
      if (
        typeof obsId !== "string" ||
        typeof entry?.embedding !== "string" ||
        typeof entry?.sessionId !== "string"
      ) {
        continue;
      }
      try {
        idx.vectors.set(obsId, {
          embedding: base64ToFloat32(entry.embedding),
          sessionId: entry.sessionId,
        });
      } catch {
        // skip a corrupt row rather than fail the whole restore
      }
    }
    return idx;
  }
}
