//
// Barrel + single registration entrypoint for the Phase-0 core functions
// (mem::observe, mem::context, mem::search). The boot path (src/index.ts)
// constructs the StateKV over the kernel and calls registerCoreFunctions to
// wire all three against the kernel's function registry in one step.

import type { ISdk } from "../kernel/index.js";
import { StateKV } from "../state/kv.js";
import { registerObserveFunction } from "./observe.js";
import { registerContextFunction } from "./context.js";
import { registerSearchFunction } from "./search.js";
import { DedupMap } from "./dedup.js";
import { getTokenBudget, getMaxObservationsPerSession } from "./config.js";

export { registerObserveFunction } from "./observe.js";
export { registerContextFunction } from "./context.js";
export { registerSearchFunction } from "./search.js";
export {
  getSearchIndex,
  getVectorIndex,
  setVectorIndex,
  getEmbeddingProvider,
  setEmbeddingProvider,
  rebuildIndex,
  vectorIndexAddGuarded,
  makeVectorIndex,
} from "./search.js";
export { QuantizedVectorIndex } from "./quantized-vector-index.js";
export type { QuantParams } from "./quantized-vector-index.js";
export { persistVectorIndex, loadVectorIndex } from "./vector-persistence.js";
export { DedupMap } from "./dedup.js";

export interface RegisterCoreOptions {
  /** Per-request context token budget. Defaults to config. */
  tokenBudget?: number;
  /** Max observations per session. Defaults to config. */
  maxObservationsPerSession?: number;
  /** Dedup map for the observe write path. Defaults to a fresh DedupMap. */
  dedupMap?: DedupMap;
}

/**
 * Register the three Phase-0 core functions against the kernel. The kernel
 * routes the five state::* ids to its StateStore, so StateKV — constructed
 * over the kernel here — is the persistence chokepoint all three share.
 */
export function registerCoreFunctions(
  sdk: ISdk,
  kv: StateKV = new StateKV(sdk),
  opts: RegisterCoreOptions = {},
): StateKV {
  const tokenBudget = opts.tokenBudget ?? getTokenBudget();
  const maxObs =
    opts.maxObservationsPerSession ?? getMaxObservationsPerSession();
  const dedupMap = opts.dedupMap ?? new DedupMap();

  registerObserveFunction(sdk, kv, dedupMap, maxObs);
  registerContextFunction(sdk, kv, tokenBudget);
  registerSearchFunction(sdk, kv);

  return kv;
}
