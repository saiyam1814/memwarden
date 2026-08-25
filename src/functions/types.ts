//
// The subset of the shared data model that the wired core functions
// (observe / context / search) and their supporting modules depend on.
// Trimmed to only the shapes the core surface touches; the wire shapes
// (HookPayload, RawObservation, CompressedObservation, Session, ...) are
// kept the stable wire contract so existing connectors can
// talk to memwarden unchanged.

import type { VectorBackend } from "./vector-backend.js";
export type { VectorBackend, VectorBackendHit } from "./vector-backend.js";

export type HookType =
  | "session_start"
  | "prompt_submit"
  | "user_prompt"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_failure"
  | "pre_compact"
  | "subagent_start"
  | "subagent_stop"
  | "notification"
  | "task_completed"
  | "stop"
  | "session_end";

export interface HookPayload {
  hookType: HookType;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
  /** Which agent captured this (claude, codex, cursor, …). Optional. */
  agent?: string;
  /**
   * Set by `memwarden adopt` when seeding a FOREIGN memory store (CLAUDE.md,
   * claude-mem, Mem0) into the brain. Such memories carry no capture-time file
   * hashes, so hashing their referenced files against the current repo would
   * forge a `verified` verdict for a fact that was never content-anchored.
   * When true, the capture path records the referenced files WITHOUT hashing
   * them, so the memory can only ever classify as `sourced_unverified` (or
   * `stale` if a referenced file is gone) — never `verified`.
   */
  adopted?: boolean;
}

export interface Session {
  id: string;
  project: string;
  cwd: string;
  /** Stable project identity (normalized git remote / main repo root) that
   * survives worktrees and moved checkouts. Additive: recall uses it only
   * to widen path scoping; key-less rows behave exactly as before. */
  projectKey?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "abandoned";
  observationCount: number;
  model?: string;
  tags?: string[];
  firstPrompt?: string;
  summary?: string;
  commitShas?: string[];
  agentId?: string;
}

export interface RawObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  hookType: HookType;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  raw: unknown;
  modality?: "text" | "image" | "mixed";
  imageData?: string;
  agentId?: string;
  /** Stable project identity at capture time (see Session.projectKey). */
  projectKey?: string;
}

export type ObservationType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "command_run"
  | "search"
  | "web_fetch"
  | "conversation"
  | "error"
  | "decision"
  | "discovery"
  | "subagent"
  | "notification"
  | "task"
  | "image"
  | "other";

/**
 * Where a memory came from — the evidence the doctor audits. A memory with
 * provenance can be checked for staleness (do its files still exist?) and
 * sourcing (is there any evidence at all?); one without is "unsourced".
 */
export interface CanonAttestation {
  format: number;
  recordId: string;
  /** Stable identity written into the Canon record. Older records may not
   * carry one; import assigns the identity of the checkout that verified it. */
  projectKey: string;
  promotedAt: string;
  capturedBy?: { host?: string; agentId?: string };
  reanchoredBy?: string;
  reanchoredAt?: string;
}

/** Fine-grained source commitments are intentionally language-neutral and
 * payload-free. The raw hash always commits to the exact captured bytes; the
 * normalized hash is additive and can only distinguish a narrowly defined
 * cosmetic transformation. */
export type FineGrainedAnchorNormalization =
  | "text-lf-trailing-whitespace-v1"
  | "json-canonical-value-v1";

export interface FineGrainedAnchorOccurrence {
  /** Exact-content occurrences observed at capture, capped by the writer. */
  count: number;
  capped: boolean;
  unique: boolean;
}

export interface FineGrainedTextLocation {
  /** 1-based lines, 0-based UTF-8 byte columns, and exclusive byte end. */
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  startByte: number;
  endByte: number;
  byteLength: number;
  lineCount: number;
  /** Dynamic line boundaries let formatting-only trailing whitespace be
   * normalized without retaining the captured source text. */
  startAtLineStart: boolean;
  endAtLineEnd: boolean;
}

export interface FineGrainedConfigLocation extends FineGrainedTextLocation {
  /** This first slice accepts only an explicit, unambiguous top-level JSON key. */
  keyPath: string[];
}

export interface FineGrainedAnchorBase {
  path: string;
  rawHash: string;
  normalizedHash: string;
  normalization: FineGrainedAnchorNormalization;
  /** Non-cryptographic rolling locator used only to find candidates. Every
   * candidate is still re-hashed with SHA-256 before it can match. */
  locatorHash: string;
  occurrence: FineGrainedAnchorOccurrence;
  contentCompleteness: "complete";
  sourceCommit?: string;
}

export interface FineGrainedEditSpanAnchor extends FineGrainedAnchorBase {
  kind: "edit_span";
  location: FineGrainedTextLocation;
}

export interface FineGrainedLineRangeAnchor extends FineGrainedAnchorBase {
  kind: "line_range";
  location: FineGrainedTextLocation;
}

export interface FineGrainedJsonConfigAnchor extends FineGrainedAnchorBase {
  kind: "json_config_value";
  location: FineGrainedConfigLocation;
}

export type FineGrainedAnchor =
  | FineGrainedEditSpanAnchor
  | FineGrainedLineRangeAnchor
  | FineGrainedJsonConfigAnchor;

export interface FineGrainedEvidence {
  format: 1;
  /** `claim` says whether the generated memory claim is wholly supported by
   * these units; `sources` says whether every referenced source is represented. */
  coverage: {
    claim: "complete" | "partial";
    sources: "complete" | "partial";
  };
  /** Derived at capture from coverage plus anchor uniqueness. Readers validate
   * the derivation and never accept this word as a cached verification result. */
  completeness: "complete" | "partial";
  anchors: FineGrainedAnchor[];
}

export interface Provenance {
  cwd?: string;
  files?: string[]; // files the memory references / was derived from
  fileHashes?: Record<string, string>; // file -> sha256 at capture, for drift checks
  /** Optional formatting-normalized commitments (currently carried by Canon).
   * These may distinguish cosmetic byte drift from semantic source drift, but
   * never replace the raw hashes used for source verification. */
  fileHashesNormalized?: Record<string, string>;
  /** Bounded fine-grained source commitments. They are advisory unless their
   * validated capture metadata proves complete claim and source coverage. */
  anchors?: FineGrainedEvidence;
  command?: string; // tool + command that produced it
  agent?: string; // which agent captured it (claude, codex, …)
  capturedAt?: string;
  userConfirmed?: boolean; // explicitly saved by a user/agent vs passively observed
  authoredBy?: "user" | "agent" | "user_or_agent";
  /** Set only by the dedicated Canon import boundary after local hash
   * verification. This records origin/attestation; it is NOT a cached trust
   * verdict. Recall still re-hashes provenance.fileHashes every time. */
  canon?: CanonAttestation;
  /** The memory's CONTENT includes material its file evidence does not cover
   * (e.g. a handoff digest mixing code-backed decisions with unsourced
   * prompts/outcomes, or inherited files dropped by a cap). File drift can
   * still prove it stale, but matching hashes can never prove it verified. */
  mixedTrust?: boolean;
}

export interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  confidence?: number;
  imageRef?: string;
  imageData?: string;
  imageDescription?: string;
  modality?: "text" | "image" | "mixed";
  agentId?: string;
  provenance?: Provenance;
}

export type MemoryLifecycleState =
  | "active"
  | "needs_revalidation"
  | "superseded"
  | "disputed"
  | "archived"
  | "revoked";

export type MemoryLifecycleAction =
  | "create"
  | "mark_needs_revalidation"
  | "supersede"
  | "dispute"
  | "archive"
  | "revoke"
  | "restore"
  | "revalidate";

/** One explicit, append-only semantic lifecycle decision. Source drift is not
 * written here during recall: it is projected as effective
 * needs_revalidation, avoiding write-on-read races. */
export interface MemoryLifecycleTransition {
  from: MemoryLifecycleState | null;
  to: MemoryLifecycleState;
  action: MemoryLifecycleAction;
  at: string;
  reason: string;
  actor?: string;
  supersededBy?: string;
}

/** A period during which this exact stored content version was believed
 * current. Inferred legacy intervals remain marked so as-of recall can be
 * honest about reconstruction quality. */
export interface MemoryValidityInterval {
  validFrom: string;
  validTo?: string;
  reason?: string;
  inferred?: true;
}

export interface Memory {
  id: string;
  createdAt: string;
  updatedAt: string;
  type:
    | "pattern"
    | "preference"
    | "architecture"
    | "bug"
    | "workflow"
    | "fact";
  title: string;
  /**
   * Structured claim fields are optional for memories created before claim-level
   * consolidation. New memories populate them so distillation does not flatten
   * away independently searchable facts or capture metadata.
   */
  subtitle?: string;
  content: string;
  facts?: string[];
  concepts: string[];
  files: string[];
  sessionIds: string[];
  strength: number;
  confidence?: number;
  version: number;
  /** Capture/validity metadata is independent of evidence freshness. */
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
  validityIntervals?: MemoryValidityInterval[];
  sourceCommit?: string;
  /** Persisted semantic state. Missing legacy state is derived conservatively
   * by the lifecycle reader without mutating storage during recall. */
  lifecycle?: MemoryLifecycleState;
  lifecycleReason?: string;
  lifecycleChangedAt?: string;
  lifecycleTransitions?: MemoryLifecycleTransition[];
  lifecycleMigratedFromLegacy?: true;
  origin?: "manual";
  parentId?: string;
  supersedes?: string[];
  supersededBy?: string;
  relatedIds?: string[];
  sourceObservationIds?: string[];
  /** Full SHA-256 identities used by conservative claim-level consolidation.
   * They let a hash collision or incompatible legacy row fail closed instead
   * of overwriting unrelated knowledge. */
  claimFingerprint?: string;
  evidenceFingerprint?: string;
  isLatest: boolean;
  retention?: "durable" | "expires";
  forgetAfter?: string;
  imageRef?: string;
  imageData?: string;
  imageDescription?: string;
  modality?: "text" | "image" | "mixed";
  agentId?: string;
  /** Capture-time project filesystem path. Kept separate from projectKey so
   * verification always has a real checkout path to read. */
  projectPath?: string;
  /** Stable git-derived identity (or canonical path fallback) used only to
   * widen same-project scope across worktrees/moved clones. */
  projectKey?: string;
  /** Capture-time working directory for relative provenance paths. */
  captureCwd?: string;
  /** @deprecated Legacy overloaded path/key field. Readers migrate/fallback
   * through resolveMemoryIdentity; new writers must not populate it. */
  project?: string;
  provenance?: Provenance; // evidence trail for Verified Recall
}

/** Portable, committed representation of one distilled Memory. Paths and hash
 * keys are repository-relative; unknown additive fields remain reader-safe. */
export interface CanonRecord {
  format: number;
  id: string;
  title: string;
  content: string;
  concepts: string[];
  files: string[];
  fileHashes: Record<string, string>;
  fileHashesNormalized?: Record<string, string>;
  anchors?: FineGrainedEvidence;
  type: Memory["type"];
  /** Portable lifecycle and version lineage. These are semantic assertions,
   * not source-verification verdicts; every checkout still verifies hashes. */
  version?: number;
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
  validityIntervals?: MemoryValidityInterval[];
  sourceCommit?: string;
  lifecycle?: MemoryLifecycleState;
  lifecycleReason?: string;
  lifecycleChangedAt?: string;
  lifecycleTransitions?: MemoryLifecycleTransition[];
  lifecycleMigratedFromLegacy?: true;
  parentId?: string;
  supersedes?: string[];
  supersededBy?: string;
  relatedIds?: string[];
  /** Portable remote-derived identity of the repository this record belongs
   * to. Omitted for old records and remote-less repositories because their
   * local absolute-path identity must never enter a committed artifact. */
  projectKey?: string;
  capturedBy?: { host?: string; agentId?: string };
  promotedAt: string;
  reanchoredBy?: string;
  reanchoredAt?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  createdAt: string;
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  observationCount: number;
}

export interface ProjectProfile {
  project: string;
  updatedAt: string;
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  conventions: string[];
  commonErrors: string[];
  recentActivity: string[];
  sessionCount: number;
  totalObservations: number;
  summary?: string;
}

export interface ContextBlock {
  type: "summary" | "observation" | "memory";
  content: string;
  tokens: number;
  recency: number;
  sourceIds?: string[];
}

export interface SearchResult {
  observation: CompressedObservation;
  score: number;
  sessionId: string;
}

export interface CompactSearchResult {
  obsId: string;
  sessionId: string;
  title: string;
  type: ObservationType;
  score: number;
  timestamp: string;
}

export interface Lesson {
  id: string;
  content: string;
  context: string;
  confidence: number;
  reinforcements: number;
  source: "crystal" | "manual" | "consolidation";
  sourceIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

/**
 * Embedding provider abstraction. The the core vector stream is stubbed to
 * empty (no provider wired), so this only needs to exist for the
 * VectorIndex / hybrid-fusion plumbing to typecheck; an actual provider
 * lands in a later phase.
 */
export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  embedImage?(src: string): Promise<Float32Array>;
}

/** A single vector-stream hit, shared by every vector index implementation. */
export interface VectorSearchHit {
  obsId: string;
  sessionId: string;
  score: number;
}

/**
 * The vector-index surface consumed by search.ts and vector-persistence.ts.
 * The contract itself lives in vector-backend.ts (VectorBackend); this alias
 * keeps the historical name that callers and tests import. Satisfied by
 * VectorIndex (full-precision), QuantizedVectorIndex (TS TurboQuant codes)
 * and TurbovecBackend (optional native turbovec crate).
 */
export interface VectorIndexLike extends VectorBackend {}

export interface HybridSearchResult {
  observation: CompressedObservation;
  bm25Score: number;
  vectorScore: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}
