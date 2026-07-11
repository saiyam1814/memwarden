//
// VectorBackend: the minimal contract every vector index implementation
// satisfies, extracted verbatim from how search.ts / vector-persistence.ts
// consume the index. Three implementations exist:
//
//   - VectorIndex           ("typescript/full")            full-precision baseline
//   - QuantizedVectorIndex  ("typescript/turboquant-Nbit") portable TS TurboQuant codes
//   - TurbovecBackend       ("turbovec/native-Nbit")       optional native turbovec crate
//
// `backendLabel` is the honest, machine-readable answer to "which engine is
// actually serving vector search right now" — surfaced through
// GET /memwarden/stats and `memwarden status`. A native backend that failed
// to load MUST NOT report a native label; the fallback path constructs a
// TypeScript backend, whose label says so.

/** A single vector-search hit. Structurally identical to types.VectorSearchHit. */
export interface VectorBackendHit {
  obsId: string;
  sessionId: string;
  score: number;
}

export interface VectorBackend {
  /**
   * Which engine this is, e.g. "typescript/full",
   * "typescript/turboquant-4bit", "turbovec/native-4bit". Stable strings:
   * stats consumers and the CLI print them as-is.
   */
  readonly backendLabel: string;
  add(obsId: string, sessionId: string, embedding: Float32Array): void;
  remove(obsId: string): void;
  has(obsId: string): boolean;
  /** Snapshot of the stored obsIds; used for restore reconciliation. */
  ids(): string[];
  search(query: Float32Array, limit?: number): VectorBackendHit[];
  readonly size: number;
  clear(): void;
  validateDimensions(expected: number): {
    mismatches: Array<{ obsId: string; dim: number }>;
    seenDimensions: Set<number>;
  };
  /**
   * Persistence contract: a self-describing string blob. Restore is
   * per-implementation (static deserialize / instance restore); a blob a
   * backend does not recognize means "rebuild from the source of truth".
   */
  serialize(): string;
}
