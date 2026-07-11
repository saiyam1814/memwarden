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
export interface Provenance {
  cwd?: string;
  files?: string[]; // files the memory references / was derived from
  fileHashes?: Record<string, string>; // file -> sha256 at capture, for drift checks
  command?: string; // tool + command that produced it
  agent?: string; // which agent captured it (claude, codex, …)
  capturedAt?: string;
  userConfirmed?: boolean; // explicitly saved by the user vs passively observed
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
  content: string;
  concepts: string[];
  files: string[];
  sessionIds: string[];
  strength: number;
  version: number;
  parentId?: string;
  supersedes?: string[];
  relatedIds?: string[];
  sourceObservationIds?: string[];
  isLatest: boolean;
  forgetAfter?: string;
  imageRef?: string;
  imageData?: string;
  agentId?: string;
  project?: string;
  provenance?: Provenance; // evidence trail for Verified Recall
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
