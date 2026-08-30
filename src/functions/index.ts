//
// Barrel + single registration entrypoint for the core functions. The boot
// path (src/index.ts) constructs the StateKV over the kernel and calls
// registerCoreFunctions so observe/context/search and bounded auxiliary
// boundaries such as Canon share one persistence chokepoint.

import type { ISdk } from "../kernel/index.js";
import { StateKV } from "../state/kv.js";
import { registerObserveFunction } from "./observe.js";
import { registerContextFunction } from "./context.js";
import { registerSearchFunction } from "./search.js";
import { registerForgetFunction } from "./forget.js";
import { registerConsolidateFunction } from "./consolidate.js";
import { registerDoctorFunction } from "./doctor.js";
import { registerDejaFixFunctions } from "./dejafix.js";
import { registerReceiptFunction } from "./receipt.js";
import { registerWhyFunction } from "./why.js";
import { registerRememberFunction } from "./remember.js";
import { registerCanonFunctions } from "./canon.js";
import { registerLifecycleFunction } from "./lifecycle.js";
import { registerManagementFunctions } from "./management.js";
import { DedupMap } from "./dedup.js";
import { getTokenBudget, getMaxObservationsPerSession } from "./config.js";

export {
  registerObserveFunction,
  sessionProjectMismatch,
} from "./observe.js";
export { registerContextFunction } from "./context.js";
export { registerSearchFunction } from "./search.js";
export { registerForgetFunction } from "./forget.js";
export { registerConsolidateFunction } from "./consolidate.js";
export {
  hasProjectIdentity,
  isStableProjectKey,
  listMemoryInventory,
  migrateLegacyMemoryIdentity,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  sessionProjectIdentity,
} from "./memory-identity.js";
export type {
  MemoryIdentityRecord,
  ProjectIdentity,
  ResolvedMemoryIdentity,
} from "./memory-identity.js";
export { registerDoctorFunction } from "./doctor.js";
export type { DoctorReport } from "./doctor.js";
export { registerReceiptFunction } from "./receipt.js";
export type { DeleteReceipt, ForgetResult } from "./receipt.js";
export { registerWhyFunction } from "./why.js";
export type { WhyResult } from "./why.js";
export {
  registerRememberFunction,
  rememberMemory,
  normalizeManualFiles,
  MANUAL_MEMORY_KINDS,
} from "./remember.js";
export type {
  RememberMemoryInput,
  RememberMemoryResult,
} from "./remember.js";
export {
  CANON_FORMAT,
  CANON_EXPORT_DEFAULT_PAGE,
  CANON_EXPORT_MAX_PAGE,
  canonProjectIdentity,
  importCanonRecord,
  isCanonRecord,
  isPortableCanonPath,
  listCanonMemories,
  memoryMatchesCanonProject,
  registerCanonFunctions,
} from "./canon.js";
export type {
  CanonExportPage,
  CanonImportResult,
  CanonProjectIdentity,
} from "./canon.js";
export {
  FINE_GRAINED_EVIDENCE_FORMAT,
  MAX_FINE_GRAINED_ANCHORS,
  MAX_ANCHOR_FILE_BYTES,
  MAX_ANCHOR_CONTENT_BYTES,
  MAX_ANCHOR_CONTEXT_BYTES,
  MAX_ANCHOR_CONTEXT_LINES,
  MAX_ANCHOR_INLINE_CONTEXT_BYTES,
  MAX_ANCHOR_LINES,
  bindFineGrainedEvidenceToCanon,
  bindFineGrainedEvidenceToMemory,
  captureFineGrainedEvidence,
  canonicalFineGrainedEvidence,
  cloneFineGrainedEvidence,
  fineGrainedClaimForCanon,
  fineGrainedClaimForMemory,
  fineGrainedClaimForObservation,
  fineGrainedEvidenceMatchesClaim,
  isActionableFineGrainedEvidence,
  isFineGrainedEvidence,
  isPortableAnchorPath,
  sourceCommitAt,
  verifyFineGrainedEvidence,
} from "./anchors.js";
export type {
  CaptureFineGrainedEvidenceInput,
  FineGrainedAnchorCheck,
  FineGrainedAnchorStatus,
  FineGrainedCanonClaim,
  FineGrainedMemoryClaim,
  FineGrainedVerification,
} from "./anchors.js";
export type {
  FineGrainedAnchor,
  FineGrainedAnchorBase,
  FineGrainedAnchorNormalization,
  FineGrainedAnchorOccurrence,
  FineGrainedClaimCommitment,
  FineGrainedClaimSchema,
  FineGrainedConfigLocation,
  FineGrainedContextSide,
  FineGrainedEditSpanAnchor,
  FineGrainedInlineContextSide,
  FineGrainedEvidence,
  FineGrainedJsonConfigAnchor,
  FineGrainedLineRangeAnchor,
  FineGrainedTextContext,
  FineGrainedTextLocation,
} from "./types.js";
export {
  registerLifecycleFunction,
  transitionMemoryLifecycle,
} from "./lifecycle.js";
export type {
  TransitionMemoryLifecycleInput,
  TransitionMemoryLifecycleResult,
} from "./lifecycle.js";
export {
  MEMORY_HISTORY_DEFAULT_LIMIT,
  MEMORY_HISTORY_MAX_LIMIT,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_MAX_LIMIT,
  PROJECT_LIST_DEFAULT_LIMIT,
  PROJECT_LIST_MAX_LIMIT,
  ManagementError,
  archiveManagedMemory,
  editManagedMemory,
  historyManagedMemory,
  listManagedMemories,
  listManagedProjects,
  managementHttpStatus,
  managementProjectRoot,
  registerManagementFunctions,
  revalidateManagedMemory,
  showManagedMemory,
  transitionStatus,
} from "./management.js";
export type {
  EditManagedMemoryInput,
  EditManagedMemoryResult,
  ListManagedMemoriesInput,
  ManagedAnchorStatus,
  ManagedAnchorSummary,
  ManagedHistoryResult,
  ManagedMemoryDetails,
  ManagedMemoryListPage,
  ManagedMemorySummary,
  ManagedTransitionInput,
  ManagementStatus,
  ProjectAggregate,
  ProjectListPage,
} from "./management.js";
export {
  MEMORY_LIFECYCLE_ACTIONS,
  MEMORY_LIFECYCLE_STATES,
  applyMemoryLifecycleTransition,
  evaluateMemoryAsOf,
  initializeMemoryLifecycle,
  isValidRecordedLifecycleTransition,
  lifecycleProjection,
  memoryLifecycleMetadata,
  migrateLegacyMemoryLifecycle,
  persistedLifecycleOf,
  validityIntervalsOf,
} from "./memory-lifecycle.js";
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
 * Register the core functions against the kernel. The kernel routes the five
 * state::* ids to its StateStore, so StateKV — constructed over the kernel
 * here — is the persistence chokepoint every registered boundary shares.
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
  registerConsolidateFunction(sdk, kv);
  registerDoctorFunction(sdk, kv);
  registerDejaFixFunctions(sdk, kv);
  registerReceiptFunction(sdk, kv);
  registerWhyFunction(sdk, kv);
  registerRememberFunction(sdk, kv);
  registerCanonFunctions(sdk, kv);
  registerLifecycleFunction(sdk, kv);
  registerManagementFunctions(sdk, kv);

  return kv;
}
