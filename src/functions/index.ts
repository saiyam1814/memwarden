//
// Barrel + single registration entrypoint for the core functions
// (mem::observe, mem::context, mem::search). The boot path (src/index.ts)
// constructs the StateKV over the kernel and calls registerCoreFunctions to
// wire all three against the kernel's function registry in one step.

import type { ISdk } from "../kernel/index.js";
import { StateKV } from "../state/kv.js";
import { registerObserveFunction } from "./observe.js";
import { registerContextFunction } from "./context.js";
import { registerSearchFunction } from "./search.js";
import { registerForgetFunction } from "./forget.js";
import { registerDoctorFunction } from "./doctor.js";
import { registerDejaFixFunctions } from "./dejafix.js";
import { registerReceiptFunction } from "./receipt.js";
import { DedupMap } from "./dedup.js";
import { getTokenBudget, getMaxObservationsPerSession } from "./config.js";

export { registerObserveFunction } from "./observe.js";
export { registerContextFunction } from "./context.js";
export { registerSearchFunction } from "./search.js";
export { registerForgetFunction } from "./forget.js";
export { registerDoctorFunction } from "./doctor.js";
export type { DoctorReport } from "./doctor.js";
export { registerReceiptFunction } from "./receipt.js";
export type { DeleteReceipt, ForgetResult } from "./receipt.js";
export {
  registerDejaFixFunctions,
  recordFix,
  lookupFix,
  errorSignature,
  looksLikeResolvedFix,
  DEJAFIX_SCOPE,
} from "./dejafix.js";
export type { FixMemory, VerifiedFix, RecordFixInput } from "./dejafix.js";
export {
  getSearchIndex,
  getVectorIndex,
  setVectorIndex,
  getEmbeddingProvider,
  setEmbeddingProvider,
  rebuildIndex,
  vectorIndexAddGuarded,
  vectorIndexAddBatchGuarded,
  makeVectorIndex,
  makeConfiguredVectorIndex,
} from "./search.js";
export type { PendingVectorDoc } from "./search.js";
export { QuantizedVectorIndex } from "./quantized-vector-index.js";
export type { QuantParams } from "./quantized-vector-index.js";
export type { VectorBackend, VectorBackendHit } from "./vector-backend.js";
export {
  TurbovecBackend,
  createTurbovecBackend,
  loadNativeTurbovec,
} from "./turbovec-backend.js";
export type {
  NativeTurbovecModule,
  NativeTurbovecIndex,
} from "./turbovec-backend.js";
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
 * Register the three core functions against the kernel. The kernel
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
  registerForgetFunction(sdk, kv);
  registerDoctorFunction(sdk, kv);
  registerDejaFixFunctions(sdk, kv);
  registerReceiptFunction(sdk, kv);

  return kv;
}
