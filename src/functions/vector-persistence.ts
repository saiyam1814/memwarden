//
// Quantized-vector-index persistence. Net-new wiring: the core dropped the
// earlier engine's IndexPersistence sync hooks, so nothing else saves or loads
// vector state. Best-effort soft-fail throughout, matching search.ts:
// a persistence problem must never break observe/search.
//
// Layout: one blob under the `quantParams` scope. The blob embeds its own
// params (seed, bits, dims, version, level-table hash); deserialize
// validates them and returns null on any mismatch, which callers treat as
// "rebuild from source of truth".

import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { QuantizedVectorIndex } from "./quantized-vector-index.js";
import { getVectorIndex, setVectorIndex, getEmbeddingProvider } from "./search.js";
import { isQuantizedVectorEnabled, getQuantRescoreDepth } from "./config.js";
import { logger } from "./logger.js";

const BLOB_KEY = "index-blob";

/**
 * Persists the current quantized index. No-op (false) when quantization is
 * disabled or the active index is not a QuantizedVectorIndex.
 */
export async function persistVectorIndex(kv: StateKV): Promise<boolean> {
  const idx = getVectorIndex();
  if (!isQuantizedVectorEnabled() || !(idx instanceof QuantizedVectorIndex)) {
    return false;
  }
  try {
    await kv.set(KV.quantParams, BLOB_KEY, idx.serialize());
    return true;
  } catch (err) {
    logger.warn("vector-persistence: persist failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Loads a previously persisted quantized index and installs it as the
 * active vector index. Returns true only when a valid blob was loaded AND
 * its params match the current configuration (and the provider dimensions,
 * when a provider is wired). Any mismatch leaves the current index in
 * place and returns false so the caller can rebuild.
 */
export async function loadVectorIndex(kv: StateKV): Promise<boolean> {
  if (!isQuantizedVectorEnabled()) return false;
  try {
    const blob = await kv.get<string>(KV.quantParams, BLOB_KEY);
    if (typeof blob !== "string" || !blob) return false;
    const idx = QuantizedVectorIndex.deserialize(blob);
    if (!idx) {
      logger.warn(
        "vector-persistence: stored index params no longer valid — rebuild required",
      );
      return false;
    }
    const provider = getEmbeddingProvider();
    if (provider && provider.dimensions !== idx.params.dims) {
      logger.warn("vector-persistence: stored dims mismatch provider — rebuild", {
        stored: idx.params.dims,
        provider: provider.dimensions,
      });
      return false;
    }
    // The blob carries the rescore setting it was built with; the current
    // environment wins. Lowering to 0 also frees the retained full vectors.
    idx.reconcileRescoreDepth(getQuantRescoreDepth());
    setVectorIndex(idx);
    return true;
  } catch (err) {
    logger.warn("vector-persistence: load failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
