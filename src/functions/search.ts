//
// Search (mem::search): hybrid BM25 + vector (RRF) retrieval with a lazy index
// rebuild, project/cwd over-fetch + canonical-path post-filter, a memory-scope
// fallback, always-on provenance classification separated from inclusion
// policy (current / historical / all, with safe_only kept as a compatibility
// alias), and three output formats (full / compact / narrative) with
// token-budget packing. When an
// embedding provider is active (the default: on-device MiniLM + TurboQuant)
// the vector stream is fused in; with no provider it runs BM25-only.

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type {
  CompressedObservation,
  Memory,
  MemoryLifecycleState,
  SearchResult,
  Session,
  EmbeddingProvider,
  VectorIndexLike,
} from "./types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import { QuantizedVectorIndex } from "./quantized-vector-index.js";
import {
  isQuantizedVectorEnabled,
  getQuantBits,
  getQuantRescoreDepth,
  getQuantSeed,
  getVectorBackend,
  getRecallPolicy,
  isScopedVectorSearchEnabled,
} from "./config.js";
import { isMemoryRecallable, memoryToObservation } from "./memory-utils.js";
import {
  hasProjectIdentity,
  listMemoryInventory,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  sessionProjectIdentity,
  type ProjectIdentity,
} from "./memory-identity.js";
import { canonicalizePath } from "./paths.js";
import { projectKey as computeProjectKey } from "./git-identity.js";
import {
  classifyProvenance,
  evidenceTrustOf,
  type EvidenceTrust,
  type LiveSourceStatus,
  type Verdict,
} from "./verify.js";
import {
  evaluateMemoryAsOf,
  lifecycleProjection,
  persistedLifecycleOf,
  validityIntervalsOf,
  type AsOfLifecycleResult,
  type LifecycleProjection,
} from "./memory-lifecycle.js";
import { recordFirewallActivity } from "./firewall-stats.js";
import { recordAccessBatch } from "./access-tracker.js";
import { loadVectorIndex, persistVectorIndex } from "./vector-persistence.js";
import { logger } from "./logger.js";
import { metrics } from "../observability/metrics.js";
import {
  fineGrainedClaimForMemory,
  fineGrainedClaimForObservation,
  type FineGrainedAnchorStatus,
} from "./anchors.js";

let index: SearchIndex | null = null;
let vectorIndex: VectorIndexLike | null = null;

// Whether this process has done its cold KV->index rebuild yet. See the
// comment at the rebuild site: gating rebuild on index size alone hides
// pre-restart memories when an observe lands before the first search.
let coldRebuildDone = false;

/** Test-only: simulate a fresh process (production restarts reset this). */
export function __resetColdRebuildForTests(): void {
  coldRebuildDone = false;
}
let currentEmbeddingProvider: EmbeddingProvider | null = null;

export function getSearchIndex(): SearchIndex {
  if (!index) index = new SearchIndex();
  return index;
}

export function setVectorIndex(idx: VectorIndexLike | null): void {
  vectorIndex = idx;
}

export function getVectorIndex(): VectorIndexLike | null {
  return vectorIndex;
}

/**
 * Constructs the configured vector index: TurboQuant-backed when
 * MEMWARDEN_QUANT_VECTOR=true, the full-precision VectorIndex otherwise.
 * `dims` comes from the embedding provider that will feed the index.
 */
export function makeVectorIndex(dims: number): VectorIndexLike {
  if (isQuantizedVectorEnabled()) {
    return new QuantizedVectorIndex({
      dims,
      bits: getQuantBits(),
      seed: getQuantSeed(),
      rescoreDepth: getQuantRescoreDepth(),
    });
  }
  return new VectorIndex();
}

/**
 * Async variant that honors MEMWARDEN_VECTOR_BACKEND. "turbovec" tries the
 * optional native '@memwarden/turbovec' binding; when it cannot be loaded
 * the failure is logged (never silent) and the TypeScript index from
 * makeVectorIndex serves instead — so the returned index's backendLabel is
 * always the truth. The default backend is "typescript" until the
 * benchmark gate passes (see config.ts getVectorBackend). The import is
 * dynamic so the turbovec module stays out of every boot that doesn't ask
 * for it.
 */
export async function makeConfiguredVectorIndex(dims: number): Promise<VectorIndexLike> {
  const configured = getVectorBackend();
  if (configured === "turbovec" || configured === "auto") {
    const { createTurbovecBackend } = await import("./turbovec-backend.js");
    const backend = await createTurbovecBackend(dims, getQuantBits(), {
      // auto probes quietly: absence of the optional package is the normal
      // case, not a warning. An EXPLICIT turbovec request that fails still
      // logs loudly (createTurbovecBackend handles both).
      quiet: configured === "auto",
    });
    if (backend) return backend;
  }
  return makeVectorIndex(dims);
}

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  currentEmbeddingProvider = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  return currentEmbeddingProvider;
}

export function vectorIndexRemove(id: string): void {
  vectorIndex?.remove(id);
}

// Hard cap on embedding input length. Truncate defensively so a huge
// content blob can't 400 the embed call or blow context budget on a single
// doc. 16k chars ≈ 4k tokens, safely under every provider.
const EMBED_MAX_CHARS = 16_000;

export function clipEmbedInput(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text;
  return text.slice(0, EMBED_MAX_CHARS);
}

// Single guarded vector-index write. Returns true on success. Soft-fails
// (logs + no-op) on dimension mismatch or embed error so a downed embedder
// never breaks the upstream save. With no provider configured this returns
// false immediately; observe.ts treats false as "vector skipped", not an error.
export async function vectorIndexAddGuarded(
  id: string,
  sessionId: string,
  text: string,
  context: { kind: "memory" | "observation" | "synthetic"; logId: string },
): Promise<boolean> {
  const vi = vectorIndex;
  const ep = currentEmbeddingProvider;
  if (!vi || !ep) return false;
  try {
    const embedding = await ep.embed(clipEmbedInput(text));
    if (embedding.length !== ep.dimensions) {
      logger.warn("vector-index add: dimension mismatch — skipping", {
        kind: context.kind,
        id: context.logId,
        provider: ep.name,
        expected: ep.dimensions,
        received: embedding.length,
      });
      return false;
    }
    vi.add(id, sessionId, embedding);
    return true;
  } catch (err) {
    logger.warn("vector-index add: embed failed — skipping", {
      kind: context.kind,
      id: context.logId,
      provider: ep.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** A doc whose vector is pending; embedded in batches by
 * vectorIndexAddBatchGuarded instead of one embed() round-trip per doc. */
export interface PendingVectorDoc {
  id: string;
  sessionId: string;
  text: string;
  context: { kind: "memory" | "observation" | "synthetic"; logId: string };
}

// Chunk size for batched embedding during rebuild. Large enough to amortize
// the per-call model overhead, small enough that one chunk failing (and
// falling back to per-doc embeds) stays cheap.
export const EMBED_BATCH_SIZE = 64;

/**
 * Batched counterpart of vectorIndexAddGuarded: embeds `docs` in chunks of
 * EMBED_BATCH_SIZE via the provider's embedBatch and adds each result to the
 * vector index. Failure semantics mirror the per-doc path, per chunk: a
 * failing embedBatch call (or a row-count mismatch) falls back to per-doc
 * guarded adds for that chunk only, so one bad doc can never skip its 63
 * healthy neighbors; a per-row dimension mismatch skips just that row.
 * Returns the number of vectors actually added. With no index/provider
 * configured this is a no-op returning 0, same as the per-doc path.
 */
export async function vectorIndexAddBatchGuarded(
  docs: PendingVectorDoc[],
): Promise<number> {
  const vi = vectorIndex;
  const ep = currentEmbeddingProvider;
  if (!vi || !ep || docs.length === 0) return 0;
  let added = 0;
  for (let start = 0; start < docs.length; start += EMBED_BATCH_SIZE) {
    const chunk = docs.slice(start, start + EMBED_BATCH_SIZE);
    let embeddings: Float32Array[] | null = null;
    try {
      embeddings = await ep.embedBatch(chunk.map((d) => clipEmbedInput(d.text)));
      if (embeddings.length !== chunk.length) {
        logger.warn(
          "vector-index batch add: row-count mismatch — falling back to per-doc embeds for this chunk",
          { provider: ep.name, expected: chunk.length, received: embeddings.length },
        );
        embeddings = null;
      }
    } catch (err) {
      logger.warn(
        "vector-index batch add: embedBatch failed — falling back to per-doc embeds for this chunk",
        {
          provider: ep.name,
          chunkSize: chunk.length,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      embeddings = null;
    }
    if (!embeddings) {
      // Per-doc fallback preserves the exact old semantics: each doc soft-
      // fails independently, a downed embedder never breaks the rebuild.
      for (const d of chunk) {
        if (await vectorIndexAddGuarded(d.id, d.sessionId, d.text, d.context)) {
          added++;
        }
      }
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const d = chunk[i]!;
      const embedding = embeddings[i]!;
      if (embedding.length !== ep.dimensions) {
        logger.warn("vector-index add: dimension mismatch — skipping", {
          kind: d.context.kind,
          id: d.context.logId,
          provider: ep.name,
          expected: ep.dimensions,
          received: embedding.length,
        });
        continue;
      }
      vi.add(d.id, d.sessionId, embedding);
      added++;
    }
  }
  return added;
}

// Rebuilds the BM25 index from KV. Walks the memories scope (so
// mem::remember entries survive a restart) and every session's
// observations. The vector index is cleared in lockstep so BM25 and vector
// stay in sync; with no provider it stays empty. When a persisted
// quantized index was just restored (vector-persistence.ts), pass
// `preserveVectorIndex` to switch the vector side to INCREMENTAL SYNC:
// restored codes are kept, only docs missing from the index are embedded,
// and ghosts (ids in the blob that no longer exist in KV) are evicted at
// the end of the walk.
export async function rebuildIndex(
  kv: StateKV,
  opts?: { preserveVectorIndex?: boolean },
): Promise<number> {
  const preserveVectors = opts?.preserveVectorIndex === true;
  const idx = getSearchIndex();
  idx.clear();
  if (!preserveVectors) vectorIndex?.clear();
  // Ids seen in KV during this walk; used to evict ghosts from a restored
  // vector index. Only tracked in preserve mode.
  const liveIds = preserveVectors ? new Set<string>() : null;
  // Docs whose vectors are missing. Collected during the KV walk and embedded
  // in chunks afterwards (one embedBatch call per EMBED_BATCH_SIZE docs)
  // instead of one embed() round-trip per doc — the cold-rebuild hot spot.
  const pending: PendingVectorDoc[] = [];

  let count = 0;

  // Memories live in their own KV scope outside per-session observation
  // scopes, so they need a separate walk.
  try {
    const memories = await kv.list<Memory>(KV.memories);
    for (const memory of memories) {
      if (!isMemoryRecallable(memory)) continue;
      if (!memory.title || !memory.content) continue;
      const observation = memoryToObservation(memory);
      idx.add(observation);
      liveIds?.add(memory.id);
      if (!preserveVectors || !vectorIndex?.has(memory.id)) {
        pending.push({
          id: memory.id,
          sessionId: observation.sessionId,
          text: memory.title + " " + memory.content,
          context: { kind: "memory", logId: memory.id },
        });
      }
      count++;
    }
  } catch (err) {
    logger.warn("rebuildIndex: failed to load memories", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sessions = await kv.list<Session>(KV.sessions);
  if (sessions.length) {
    const obsPerSession: CompressedObservation[][] = [];
    const failedSessions: string[] = [];
    for (let batch = 0; batch < sessions.length; batch += 10) {
      const chunk = sessions.slice(batch, batch + 10);
      const results = await Promise.all(
        chunk.map(async (s) => {
          try {
            return await kv.list<CompressedObservation>(KV.observations(s.id));
          } catch {
            failedSessions.push(s.id);
            return [] as CompressedObservation[];
          }
        }),
      );
      obsPerSession.push(...results);
    }
    if (failedSessions.length > 0) {
      logger.warn("rebuildIndex: failed to load observations for sessions", {
        failedSessions,
      });
    }
    for (const observations of obsPerSession) {
      for (const obs of observations) {
        if (obs.title && obs.narrative) {
          idx.add(obs);
          liveIds?.add(obs.id);
          if (!preserveVectors || !vectorIndex?.has(obs.id)) {
            pending.push({
              id: obs.id,
              sessionId: obs.sessionId,
              text: obs.title + " " + obs.narrative,
              context: { kind: "observation", logId: obs.id },
            });
          }
          count++;
        }
      }
    }
  }

  await vectorIndexAddBatchGuarded(pending);
  evictGhostVectors(liveIds);
  return count;
}

// In preserve (incremental-sync) mode, removes vector entries whose ids no
// longer exist in KV — docs deleted after the index blob was persisted.
// No-op when liveIds is null (full-rebuild mode already cleared the index).
function evictGhostVectors(liveIds: Set<string> | null): void {
  if (!liveIds || !vectorIndex) return;
  let evicted = 0;
  for (const id of vectorIndex.ids()) {
    if (!liveIds.has(id)) {
      vectorIndex.remove(id);
      evicted++;
    }
  }
  if (evicted > 0) {
    logger.info("vector index: evicted ghost entries after restore", {
      evicted,
    });
  }
}

// Reciprocal Rank Fusion of two ranked lists that share the
// {obsId, sessionId, score} shape (BM25 keyword + semantic vector). Score
// becomes the summed RRF contribution; ties resolve by it. Same K as the
// HybridSearch helper.
const RRF_K = 60;
type Ranked = { obsId: string; sessionId: string; score: number };
function fuseRrf(a: Ranked[], b: Ranked[], limit: number): Ranked[] {
  const acc = new Map<string, { sessionId: string; score: number }>();
  const add = (list: Ranked[]) =>
    list.forEach((r, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      const cur = acc.get(r.obsId);
      if (cur) {
        cur.score += rrf;
        if (!cur.sessionId && r.sessionId) cur.sessionId = r.sessionId;
      } else {
        acc.set(r.obsId, { sessionId: r.sessionId, score: rrf });
      }
    });
  add(a);
  add(b);
  return Array.from(acc.entries())
    .map(([obsId, v]) => ({ obsId, sessionId: v.sessionId, score: v.score }))
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/** Merge independently scored BM25 streams, keeping one row per record. */
function mergeRanked(a: Ranked[], b: Ranked[], limit: number): Ranked[] {
  const merged = new Map<string, Ranked>();
  for (const hit of [...a, ...b]) {
    const current = merged.get(hit.obsId);
    if (!current || hit.score > current.score) merged.set(hit.obsId, hit);
  }
  return [...merged.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/**
 * Builds the obsId allowlist for a scoped vector search, mirroring the
 * post-filter's session predicate EXACTLY: a session is in scope when each
 * active path filter matches its canonical stored path OR its stable
 * projectKey (the same worktree/moved-checkout widening the post-filter
 * applies). Ids indexed under a sessionId with no live KV session —
 * memories and synthetic entries — are ALWAYS included: the post-filter
 * applies its own finer memory rules to those, and the allowlist must
 * never be narrower than the post-filter. The allowlist is an
 * optimization; the post-filter stays the correctness backstop.
 *
 * Also returns the session list so the caller can seed its per-candidate
 * session cache instead of re-reading each session from KV.
 */
export async function buildScopedAllowedIds(
  kv: StateKV,
  idx: SearchIndex,
  scope: {
    projectFilter?: string | undefined;
    cwdFilter?: string | undefined;
    projectFilterKey: string | null;
    cwdFilterKey: string | null;
  },
): Promise<{ allowed: Set<string>; sessions: Session[] }> {
  const sessions = await kv.list<Session>(KV.sessions);
  const liveById = new Map(sessions.map((s) => [s.id, s]));
  const inScope = (session: Session): boolean => {
    const identity = sessionProjectIdentity(session);
    if (
      scope.projectFilter &&
      !(identity.projectKey && identity.projectKey === scope.projectFilterKey) &&
      (!identity.projectPath ||
        canonicalizePath(identity.projectPath) !== scope.projectFilter)
    )
      return false;
    if (
      scope.cwdFilter &&
      !(identity.projectKey && identity.projectKey === scope.cwdFilterKey) &&
      (!identity.captureCwd ||
        canonicalizePath(identity.captureCwd) !== scope.cwdFilter)
    )
      return false;
    return true;
  };
  const allowed = new Set<string>();
  for (const sessionId of idx.indexedSessionIds()) {
    const live = liveById.get(sessionId);
    if (live && !inScope(live)) continue;
    const ids = idx.idsForSession(sessionId);
    if (ids) for (const id of ids) allowed.add(id);
  }
  // A distilled memory may be indexed under its first source session id. Do
  // not let that implementation detail make the optimization narrower than
  // the correctness post-filter: memory identity is resolved there from the
  // Memory row + all source sessions.
  const memories = await kv.list<Memory>(KV.memories).catch(() => [] as Memory[]);
  for (const memory of memories) {
    if (isMemoryRecallable(memory)) allowed.add(memory.id);
  }
  return { allowed, sessions };
}

// --- recall classification + serialization (always labeled) --------
//
// Classification and inclusion are deliberately separate. Every candidate
// that leaves search gets one verdict, even for an explicit historical/all
// lookup. The mode then decides whether that classified candidate is included.
// This prevents an unfiltered lookup from laundering a drifted record into
// unlabeled current context.

export type SearchMode = "current" | "historical" | "as_of" | "all";
export type SearchVerdict =
  | Verdict
  | {
      status: "unverifiable";
      reason: string;
      evidenceTrust: EvidenceTrust;
      evidenceReason: string;
      sourceStatus: "unknown";
      sourceReason: string;
    };
export type TrustLabel =
  | "verified"
  | "cosmetic"
  | "sourced"
  | "unsourced"
  | "stale"
  | "unverifiable";
export type SourceStatusLabel =
  | "source-verified"
  | "source-cosmetic"
  | "sourced"
  | "unsourced"
  | "source-drifted"
  | "unverifiable";

export function trustLabelOf(verdict: SearchVerdict): TrustLabel {
  switch (verdict.status) {
    case "verified":
      return "verified";
    case "cosmetic":
      return "cosmetic";
    case "sourced_unverified":
      return "sourced";
    case "stale":
      return "stale";
    case "unsourced":
      return "unsourced";
    case "unverifiable":
      return "unverifiable";
  }
}

export function sourceStatusOf(verdict: SearchVerdict): SourceStatusLabel {
  switch (verdict.status) {
    case "verified":
      return "source-verified";
    case "cosmetic":
      return "source-cosmetic";
    case "sourced_unverified":
      return "sourced";
    case "stale":
      return "source-drifted";
    case "unsourced":
      return "unsourced";
    case "unverifiable":
      return "unverifiable";
  }
}

interface RecallClassificationFields {
  /** Trust label; `cosmetic` is current but explicitly not byte-identical. */
  trust: TrustLabel;
  /** Backward-compatible #56 source label. */
  source_status: SourceStatusLabel;
  /** Independent lifecycle model axes. */
  evidence_trust: EvidenceTrust;
  evidence_reason: string;
  live_source_status: LiveSourceStatus;
  live_source_reason: string;
  fine_grained_anchor_status?: FineGrainedAnchorStatus;
  fine_grained_anchor_actionable?: boolean;
  persisted_lifecycle: MemoryLifecycleState;
  effective_lifecycle: MemoryLifecycleState;
  transition_reason: string;
  lifecycle_reason: string;
  observed_at: string;
  valid_from?: string;
  valid_to?: string;
  validity_reconstruction: "recorded" | "legacy_inferred" | "unavailable";
  source_commit?: string;
  attestation?: "canon-imported" | "canon-reanchored";
  /** Capture time used to frame historical records. */
  captured_at: string;
  /** Short compatibility provenance verdict. */
  evidence: string;
  historical: boolean;
  /** Present only for a stored Memory version that is no longer latest. */
  superseded?: true;
  lifecycle_as_of?: "active";
  as_of_reconstruction?: AsOfLifecycleResult["reconstruction"];
  source_status_temporality?: "current-check-only";
}

interface RecallItemBase extends RecallClassificationFields {
  obsId: string;
  sessionId: string;
  title: string;
  score: number;
  timestamp: string;
}
export interface CompactRecallItem extends RecallItemBase {
  type: CompressedObservation["type"];
}
export interface NarrativeRecallItem extends RecallItemBase {
  narrative: string;
}
export interface FullRecallItem extends SearchResult, RecallClassificationFields {}

interface RecallLifecycleContext {
  memory: Memory | null;
  projection: LifecycleProjection;
  asOf?: AsOfLifecycleResult;
}

function classificationFields(
  r: SearchResult,
  verdict: SearchVerdict,
  lifecycle: RecallLifecycleContext,
): RecallClassificationFields {
  const sourceStatus = sourceStatusOf(verdict);
  const memory = lifecycle.memory;
  const capturedAt =
    memory?.observedAt ??
    r.observation.provenance?.capturedAt ??
    r.observation.timestamp;
  const intervals = memory ? validityIntervalsOf(memory) : [];
  const latest = lifecycle.asOf?.interval ?? intervals[intervals.length - 1];
  const superseded = lifecycle.projection.persisted === "superseded";
  const canon = r.observation.provenance?.canon;
  return {
    trust: trustLabelOf(verdict),
    source_status: sourceStatus,
    evidence_trust: verdict.evidenceTrust,
    evidence_reason: verdict.evidenceReason,
    live_source_status: verdict.sourceStatus,
    live_source_reason: verdict.sourceReason,
    ...(verdict.status !== "unverifiable" && verdict.fineGrained
      ? {
          fine_grained_anchor_status: verdict.fineGrained.status,
          fine_grained_anchor_actionable: verdict.fineGrained.actionable,
        }
      : {}),
    persisted_lifecycle: lifecycle.projection.persisted,
    effective_lifecycle: lifecycle.projection.effective,
    transition_reason: lifecycle.projection.persistedReason,
    lifecycle_reason: lifecycle.projection.effectiveReason,
    observed_at: capturedAt,
    ...(latest?.validFrom
      ? { valid_from: latest.validFrom }
      : { valid_from: capturedAt }),
    ...(latest?.validTo ? { valid_to: latest.validTo } : {}),
    validity_reconstruction: lifecycle.asOf
      ? lifecycle.asOf.reconstruction === "exact"
        ? "recorded"
        : lifecycle.asOf.reconstruction
      : memory
        ? intervals.length === 0
          ? "unavailable"
          : intervals.some((interval) => interval.inferred)
            ? "legacy_inferred"
            : "recorded"
        : "unavailable",
    ...(memory?.sourceCommit ? { source_commit: memory.sourceCommit } : {}),
    ...(canon
      ? {
          attestation: canon.reanchoredAt
            ? ("canon-reanchored" as const)
            : ("canon-imported" as const),
        }
      : {}),
    captured_at: capturedAt,
    evidence: verdict.reason,
    historical:
      lifecycle.projection.effective !== "active" || lifecycle.asOf !== undefined,
    ...(superseded ? { superseded: true as const } : {}),
    ...(lifecycle.asOf?.active
      ? {
          lifecycle_as_of: "active" as const,
          as_of_reconstruction: lifecycle.asOf.reconstruction,
          source_status_temporality: "current-check-only" as const,
        }
      : {}),
  };
}

function defaultLifecycleContext(
  superseded = false,
): RecallLifecycleContext {
  const persisted: MemoryLifecycleState = superseded ? "superseded" : "active";
  const reason = superseded
    ? "legacy serializer flag marks this version superseded"
    : "observation defaults to active";
  return {
    memory: null,
    projection: {
      persisted,
      effective: persisted,
      persistedReason: reason,
      effectiveReason: reason,
    },
  };
}

function normalizeLifecycleContext(
  value: RecallLifecycleContext | boolean | undefined,
): RecallLifecycleContext {
  return typeof value === "object"
    ? value
    : defaultLifecycleContext(value === true);
}

export function serializeRecallItem(
  r: SearchResult,
  format: "compact",
  verdict: SearchVerdict,
  lifecycle?: RecallLifecycleContext | boolean,
): CompactRecallItem;
export function serializeRecallItem(
  r: SearchResult,
  format: "narrative",
  verdict: SearchVerdict,
  lifecycle?: RecallLifecycleContext | boolean,
): NarrativeRecallItem;
export function serializeRecallItem(
  r: SearchResult,
  format: "compact" | "narrative",
  verdict: SearchVerdict,
  lifecycle?: RecallLifecycleContext | boolean,
): CompactRecallItem | NarrativeRecallItem {
  const base: RecallItemBase = {
    obsId: r.observation.id,
    sessionId: r.sessionId,
    title: r.observation.title,
    score: r.score,
    timestamp: r.observation.timestamp,
    ...classificationFields(r, verdict, normalizeLifecycleContext(lifecycle)),
  };
  return format === "compact"
    ? { ...base, type: r.observation.type }
    : { ...base, narrative: r.observation.narrative };
}

function serializeFullRecallItem(
  r: SearchResult,
  verdict: SearchVerdict,
  lifecycle?: RecallLifecycleContext | boolean,
): FullRecallItem {
  return {
    ...r,
    ...classificationFields(r, verdict, normalizeLifecycleContext(lifecycle)),
  };
}

/** One narrative line, label first — the text surfaces (hooks, proxy, MCP
 * resume) inject exactly this, so the label travels with the memory. Drifted
 * content also carries explicit capture-time + evidence framing in the text,
 * not only in adjacent JSON metadata. */
export function formatNarrativeItem(
  item: NarrativeRecallItem,
  idx: number,
): string {
  const sourceLabel =
    item.source_status === "source-verified" ? item.trust : item.source_status;
  const lifecycleLabel =
    item.effective_lifecycle !== "active"
      ? `[${item.effective_lifecycle}] `
      : "";
  const labels = `${item.lifecycle_as_of ? "[as-of] " : ""}${lifecycleLabel}[${sourceLabel}] `;
  const validity = `${item.valid_from ?? item.captured_at}${item.valid_to ? ` to ${item.valid_to}` : " onward"}`;
  const historicalFrame = item.historical
    ? `Historical record captured ${item.captured_at}; recorded validity ${validity} (${item.validity_reconstruction}). Evidence: ${item.evidence}. Effective lifecycle: ${item.lifecycle_reason}\n`
    : "";
  const asOfFrame = item.lifecycle_as_of
    ? `As-of reconstruction: ${item.as_of_reconstruction}; source status is a current-check-only label, not reconstructed history.\n`
    : "";
  return `${idx + 1}. ${labels}${item.title}\n${historicalFrame}${asOfFrame}${item.narrative}`;
}

function usableCheckoutRoot(value: string | undefined): string | null {
  if (!value || !isAbsolute(value)) return null;
  try {
    return existsSync(value) && statSync(value).isDirectory()
      ? canonicalizePath(value)
      : null;
  } catch {
    return null;
  }
}

function normalizeTrustFilter(raw: unknown): Set<SourceStatusLabel> | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("mem::search: trust must be a non-empty array");
  }
  const aliases: Record<string, SourceStatusLabel> = {
    verified: "source-verified",
    "source-verified": "source-verified",
    cosmetic: "source-cosmetic",
    "source-cosmetic": "source-cosmetic",
    sourced: "sourced",
    "sourced-unverified": "sourced",
    unsourced: "unsourced",
    stale: "source-drifted",
    "source-drifted": "source-drifted",
    unverifiable: "unverifiable",
  };
  const normalized = new Set<SourceStatusLabel>();
  for (const item of raw) {
    if (typeof item !== "string" || aliases[item.trim().toLowerCase()] === undefined) {
      throw new Error(
        "mem::search: trust entries must be one of source-verified, source-cosmetic, sourced, unsourced, source-drifted, or unverifiable",
      );
    }
    normalized.add(aliases[item.trim().toLowerCase()]!);
  }
  return normalized;
}

export function registerSearchFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::search",
    async (data: {
      query: string;
      limit?: number;
      project?: string;
      cwd?: string;
      format?: string;
      token_budget?: number;
      /** Compatibility flag used by existing automatic recall surfaces. */
      safe_only?: boolean;
      /** Explicit inclusion policy. Classification runs in every mode. */
      mode?: string;
      /** ISO timestamp required by mode=as_of. Time reconstruction is bounded
       * to stored Memory validity intervals; observation history is labeled
       * unavailable rather than inferred from oplog commitments. */
      as_of?: string;
      /** Backward-compatible alias for mode=all when true, current when false. */
      include_drifted?: boolean;
      /** Optional source-status allowlist, applied after classification. */
      trust?: unknown;
      /** Inventory mode used by Canon push: returns stored Memory records
       * rather than ranked observations. */
      include_memories?: boolean;
      all_projects?: boolean;
    }) => {
      const idx = getSearchIndex();

      // Canon needs an inventory, not a magic broad search query. Keep this an
      // explicit mode so normal search still rejects empty queries and cannot
      // accidentally dump the whole brain.
      const rawQuery =
        typeof data?.query === "string" ? data.query.trim() : "";
      if (!rawQuery && data?.include_memories === true) {
        if (
          data.limit !== undefined &&
          (!Number.isInteger(data.limit) || data.limit < 1)
        ) {
          throw new Error("mem::search: limit must be a positive integer");
        }
        const scope =
          data.all_projects === true
            ? undefined
            : typeof data.project === "string" && data.project.trim()
              ? data.project.trim()
              : typeof data.cwd === "string" && data.cwd.trim()
                ? data.cwd.trim()
                : undefined;
        if (data.all_projects !== true && !scope) {
          throw new Error(
            "mem::search: memory inventory requires project/cwd unless all_projects is true",
          );
        }
        const memories = await listMemoryInventory(kv, scope);
        const inventoryLimit = Math.min(data.limit ?? 1000, 10_000);
        return {
          format: "inventory",
          results: [],
          memories: memories.slice(0, inventoryLimit),
        };
      }

      // Input validation / normalization.
      if (!rawQuery) {
        throw new Error("mem::search: query must be a non-empty string");
      }
      const query = rawQuery;
      const MAX_LIMIT = 100;
      let effectiveLimit = 20;
      if (data.limit !== undefined) {
        if (!Number.isInteger(data.limit) || data.limit < 1) {
          throw new Error("mem::search: limit must be a positive integer");
        }
        effectiveLimit = Math.min(data.limit, MAX_LIMIT);
      }
      // Canonicalize the scope filters (resolve symlinks, trailing slashes,
      // `..`) so /tmp and /private/tmp — or any two spellings of the same
      // directory — match. Stored values are canonicalized the same way at
      // comparison time below.
      const projectFilter =
        typeof data.project === "string" && data.project.trim().length > 0
          ? canonicalizePath(data.project)
          : undefined;
      const cwdFilter =
        typeof data.cwd === "string" && data.cwd.trim().length > 0
          ? canonicalizePath(data.cwd)
          : undefined;
      // Stable project identity for each filter directory (git remote / main
      // repo root, canonical path fallback). Used below to WIDEN the path
      // filters — same key at a different path (worktree/moved checkout) matches.
      const projectFilterKey =
        projectFilter !== undefined ? computeProjectKey(projectFilter) : null;
      const cwdFilterKey =
        cwdFilter !== undefined ? computeProjectKey(cwdFilter) : null;
      // Inclusion policy is normalized independently from classification.
      // `safe_only` remains the fail-closed compatibility switch used by
      // SessionStart/proxy/resume and is exactly equivalent to mode=current.
      const wantsSafeOnly = data.safe_only === true;
      if (wantsSafeOnly && cwdFilter === undefined) {
        throw new Error(
          "mem::search: safe_only requires a cwd to verify memory against (the firewall fails closed)",
        );
      }
      let explicitMode: SearchMode | undefined;
      if (data.mode !== undefined) {
        if (typeof data.mode !== "string") {
          throw new Error(
            "mem::search: mode must be current, historical, as_of, or all",
          );
        }
        const normalizedMode = data.mode.trim().toLowerCase();
        if (!(["current", "historical", "as_of", "all"] as const).includes(
          normalizedMode as SearchMode,
        )) {
          throw new Error(
            "mem::search: mode must be current, historical, as_of, or all",
          );
        }
        explicitMode = normalizedMode as SearchMode;
      }
      if (
        data.include_drifted !== undefined &&
        typeof data.include_drifted !== "boolean"
      ) {
        throw new Error("mem::search: include_drifted must be a boolean");
      }
      const aliasMode: SearchMode | undefined =
        data.include_drifted === true
          ? "all"
          : data.include_drifted === false
            ? "current"
            : undefined;
      let asOfIso: string | undefined;
      if (data.as_of !== undefined) {
        if (
          typeof data.as_of !== "string" ||
          !data.as_of.trim() ||
          data.as_of.length > 128 ||
          !Number.isFinite(Date.parse(data.as_of))
        ) {
          throw new Error("mem::search: as_of must be a valid date-time string");
        }
        const parsed = Date.parse(data.as_of);
        asOfIso = new Date(parsed).toISOString();
      }
      if (explicitMode && explicitMode !== "as_of" && asOfIso) {
        throw new Error("mem::search: as_of is only compatible with mode=as_of");
      }
      if (explicitMode === "as_of" && !asOfIso) {
        throw new Error("mem::search: mode=as_of requires as_of");
      }
      const requestedMode = explicitMode ?? (asOfIso ? "as_of" : undefined);
      if (requestedMode && aliasMode && requestedMode !== aliasMode) {
        throw new Error(
          "mem::search: mode conflicts with include_drifted (true means all; false means current)",
        );
      }
      if (
        wantsSafeOnly &&
        ((requestedMode !== undefined && requestedMode !== "current") ||
          (aliasMode !== undefined && aliasMode !== "current"))
      ) {
        throw new Error("mem::search: safe_only is only compatible with mode=current");
      }
      const inclusionMode: SearchMode | "legacy" = wantsSafeOnly
        ? "current"
        : requestedMode ?? aliasMode ?? "legacy";
      const currentPolicy = inclusionMode === "current";
      const trustFilter = normalizeTrustFilter(data.trust);
      const format = typeof data.format === "string" ? data.format : "full";
      if (!["full", "compact", "narrative"].includes(format)) {
        throw new Error(
          "mem::search: format must be one of 'full', 'compact', or 'narrative'",
        );
      }
      let tokenBudget: number | undefined;
      if (data.token_budget !== undefined) {
        if (!Number.isInteger(data.token_budget) || data.token_budget < 1) {
          throw new Error(
            "mem::search: token_budget must be a positive integer",
          );
        }
        tokenBudget = data.token_budget;
      }

      // Cold rebuild must be once-per-process, NOT "when the index is empty":
      // an observation that arrives after restart but before the first search
      // makes the index non-empty, and gating on size would then hide every
      // pre-restart memory until the next clean restart. rebuildIndex clears
      // and re-walks KV, so running it over early arrivals is idempotent.
      // (The size check stays as an OR for in-process restarts in tests that
      // clear the index directly.)
      if (!coldRebuildDone || idx.size === 0) {
        // Restore persisted quantized codes first (no-op unless
        // MEMWARDEN_QUANT_VECTOR is on and a valid blob exists), then
        // rebuild BM25. With a successful restore the vector side runs in
        // incremental-sync mode (embed only missing ids, evict ghosts);
        // afterwards the reconciled index is persisted again so the blob
        // converges with KV. One blob write per cold rebuild.
        const restoredVectors = await loadVectorIndex(kv);
        const count = await rebuildIndex(kv, {
          preserveVectorIndex: restoredVectors,
        });
        const persisted = await persistVectorIndex(kv);
        coldRebuildDone = true;
        logger.info("Search index rebuilt", {
          entries: count,
          restoredVectors,
          persisted,
        });
      }

      // Inclusion filters over-fetch so a run of excluded high-ranking hits
      // cannot starve eligible results. The hard cap is surfaced in logs when
      // exhausted rather than pretending the scan was exhaustive.
      const POLICY_SCAN_CAP = 2000;
      const filtering = !!(projectFilter || cwdFilter);
      const policyFiltering =
        currentPolicy ||
        inclusionMode === "historical" ||
        inclusionMode === "as_of" ||
        trustFilter !== null;
      const fetchLimit = policyFiltering
        ? Math.min(POLICY_SCAN_CAP, Math.max(effectiveLimit * 50, 500))
        : filtering
          ? Math.max(effectiveLimit * 10, 100)
          : effectiveLimit;
      // Measure retrieval itself (not the one-time cold rebuild above) — the
      // "is finding context fast?" number.
      const searchStartedAt = performance.now();
      // Scope-aware retrieval: with a project/cwd filter active, BOTH
      // streams (BM25 keyword and vector) search WITHIN the allowlist of
      // in-scope ids so the top fetchLimit is filled with valid candidates,
      // instead of a global top-k that mostly gets post-filtered away —
      // enough stronger out-of-scope docs (>= the over-fetch window) would
      // otherwise starve a valid in-scope result entirely. Purely an
      // optimization: the scope post-filter below still runs on every
      // candidate (defense in depth), so a too-wide allowlist can never
      // leak an out-of-scope result. MEMWARDEN_SCOPED_VECTOR_SEARCH=off is
      // the kill switch back to global-scan + post-filter for both streams.
      let scopedAllowed: Set<string> | null = null;
      // Sessions preloaded by the scoped allowlist build; seeds the
      // per-candidate session cache so the post-filter doesn't re-read them.
      let preloadedSessions: Session[] | null = null;
      if (filtering && isScopedVectorSearchEnabled()) {
        const scoped = await buildScopedAllowedIds(kv, idx, {
          projectFilter,
          cwdFilter,
          projectFilterKey,
          cwdFilterKey,
        });
        scopedAllowed = scoped.allowed;
        preloadedSessions = scoped.sessions;
      }
      let bm25Results = scopedAllowed
        ? idx.search(query, fetchLimit, scopedAllowed)
        : idx.search(query, fetchLimit);
      // Historical mode must preserve one bounded window from BOTH the live
      // corpus (where source-drifted observations live) and superseded-memory
      // history. Truncating their merge back to one window before policy would
      // let 2,000 current hits starve every superseded match.
      const combinedFetchLimit =
        inclusionMode === "historical" || inclusionMode === "as_of"
          ? Math.min(POLICY_SCAN_CAP * 2, fetchLimit * 2)
          : fetchLimit;

      // Persisted non-active Memory rows are intentionally absent from the live
      // index. Historical/all mode builds a bounded temporary stream for them;
      // as_of scans every stored Memory version because a currently superseded,
      // disputed, archived, or restored row may own the requested interval.
      const historicalMemoryById = new Map<string, Memory>();
      if (
        inclusionMode === "historical" ||
        inclusionMode === "as_of" ||
        inclusionMode === "all"
      ) {
        try {
          const historicalIndex = new SearchIndex();
          const memories = await kv.list<Memory>(KV.memories);
          for (const memory of memories) {
            if (!memory.title || !memory.content) continue;
            const includeInTemporary =
              inclusionMode === "as_of" || !isMemoryRecallable(memory);
            if (!includeInTemporary) continue;
            historicalMemoryById.set(memory.id, memory);
            historicalIndex.add(memoryToObservation(memory));
          }
          bm25Results = mergeRanked(
            bm25Results,
            historicalIndex.search(query, fetchLimit),
            combinedFetchLimit,
          );
        } catch (err) {
          logger.warn("search: failed to load superseded memory history", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Fuse in the semantic stream when an embedding provider + vector index
      // are present, so meaning-based queries (different words than the
      // memory) resolve. Provider-less mode stays pure BM25. A failing
      // embed falls back to BM25 rather than breaking search.
      let results = bm25Results;
      const vIdx = getVectorIndex();
      const ep = currentEmbeddingProvider;
      if (vIdx && ep && vIdx.size > 0) {
        try {
          const qVec = await ep.embed(clipEmbedInput(query));
          if (qVec.length === ep.dimensions) {
            // The vector stream uses the same allowlist; falls back to the
            // global scan when the backend lacks searchAllowed.
            let vectorHits: Ranked[];
            if (scopedAllowed && typeof vIdx.searchAllowed === "function") {
              vectorHits =
                scopedAllowed.size > 0
                  ? vIdx.searchAllowed(qVec, fetchLimit, scopedAllowed)
                  : [];
            } else {
              vectorHits = vIdx.search(qVec, fetchLimit);
            }
            results = fuseRrf(bm25Results, vectorHits, combinedFetchLimit);
          }
        } catch (err) {
          logger.warn("search: vector stream failed — BM25 only", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      metrics.recordSearch(performance.now() - searchStartedAt);

      // Resolve session -> project/cwd once per sessionId we touch. Seeded
      // from the allowlist build when it ran (same KV data, one list read).
      const sessionCache = new Map<string, Session | null>();
      if (preloadedSessions) {
        for (const s of preloadedSessions) sessionCache.set(s.id, s);
      }
      const loadSession = async (
        sessionId: string,
      ): Promise<Session | null> => {
        if (sessionCache.has(sessionId)) return sessionCache.get(sessionId)!;
        const s = await kv.get<Session>(KV.sessions, sessionId);
        sessionCache.set(sessionId, s ?? null);
        return s ?? null;
      };

      interface CandidateSource {
        observation: CompressedObservation;
        /** Present when this index hit came from KV.memories rather than a
         * per-session observation scope. */
        memory: Memory | null;
      }

      // Cache Memory rows as records. Historical mode already loaded
      // superseded rows above, so those require no second KV hit.
      const memoryCache = new Map<string, Memory | null>();
      for (const [id, memory] of historicalMemoryById) memoryCache.set(id, memory);
      const loadMemory = async (obsId: string): Promise<Memory | null> => {
        if (memoryCache.has(obsId)) return memoryCache.get(obsId)!;
        const memory = await kv.get<Memory>(KV.memories, obsId).catch(() => null);
        memoryCache.set(obsId, memory ?? null);
        return memory ?? null;
      };

      // Resolve the actual source before applying scope. A distilled Memory is
      // often indexed under a real source session id; treating that id as the
      // Memory's identity makes direct-memory and observation verdicts disagree
      // across worktrees.
      const sourceCache = new Map<string, CandidateSource | null>();
      const loadCandidateSource = async (r: {
        obsId: string;
        sessionId: string;
      }): Promise<CandidateSource | null> => {
        const cacheKey = `${r.sessionId}\n${r.obsId}`;
        if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey)!;
        const observation = await kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (observation) {
          const source = { observation, memory: null };
          sourceCache.set(cacheKey, source);
          return source;
        }
        const memory = await loadMemory(r.obsId);
        const historical = historicalMemoryById.has(r.obsId);
        const source =
          memory && (historical || isMemoryRecallable(memory))
            ? { observation: memoryToObservation(memory), memory }
            : null;
        sourceCache.set(cacheKey, source);
        return source;
      };

      const memoryIdentityCache = new Map<string, ProjectIdentity>();
      const loadMemoryIdentity = async (
        memory: Memory,
      ): Promise<ProjectIdentity> => {
        const cached = memoryIdentityCache.get(memory.id);
        if (cached) return cached;
        const sourceSessions = new Map<string, Session>();
        for (const sessionId of memory.sessionIds ?? []) {
          const session = await loadSession(sessionId);
          if (session) sourceSessions.set(sessionId, session);
        }
        const identity = resolveMemoryIdentity(memory, sourceSessions);
        memoryIdentityCache.set(memory.id, identity);
        return identity;
      };

      // Cross-project classification may need another live checkout for the
      // candidate's own stable project key. Load the session registry at most
      // once and cache it alongside per-id reads.
      let allSessions = preloadedSessions;
      const loadAllSessions = async (): Promise<Session[]> => {
        if (allSessions) return allSessions;
        allSessions = await kv.list<Session>(KV.sessions).catch(() => []);
        for (const session of allSessions) sessionCache.set(session.id, session);
        return allSessions;
      };

      const unverifiable = (
        provenance: CompressedObservation["provenance"],
      ): SearchVerdict => {
        const reason =
          "the source checkout is unavailable, so capture-time file evidence cannot be checked";
        const evidenceTrust = evidenceTrustOf(provenance);
        return {
          status: "unverifiable",
          reason,
          evidenceTrust,
          evidenceReason:
            evidenceTrust === "verified"
              ? "capture-time file commitments exist, but no live checkout is available"
              : evidenceTrust === "sourced"
                ? "source or confirmation evidence exists without a currently checkable checkout"
                : "no source evidence was captured",
          sourceStatus: "unknown",
          sourceReason: reason,
        };
      };

      /** Classify against the caller checkout for a proven same-project scoped
       * result; otherwise against the candidate's own known live checkout.
       * Missing cross-project checkouts are not called current or drifted — the
       * honest answer is unverifiable. */
      const classifyForSearch = async (
        obs: CompressedObservation,
        identity: ProjectIdentity,
        memory: Memory | null,
      ): Promise<SearchVerdict> => {
        const files = obs.provenance?.files ?? [];
        const fineGrainedClaim = memory
          ? fineGrainedClaimForMemory(memory)
          : fineGrainedClaimForObservation(obs);
        const needsRelativeRoot = files.some((file) => !isAbsolute(file));

        // File-less provenance (command/user confirmation/none) does not need a
        // checkout. The classifier can determine sourced vs unsourced directly.
        if (files.length === 0) {
          return classifyProvenance(
            obs.provenance,
            cwdFilter ?? projectFilter ?? "/",
            { fineGrainedClaim },
          );
        }

        const scopedFilter = cwdFilter ?? projectFilter;
        if (scopedFilter) {
          const callerRoot = usableCheckoutRoot(scopedFilter);
          const sameProject =
            hasProjectIdentity(identity) &&
            projectIdentityMatchesPath(identity, scopedFilter);
          const mustUseCallerCheckout =
            cwdFilter !== undefined || usableCheckoutRoot(obs.provenance?.cwd) === null;
          if (callerRoot && sameProject && mustUseCallerCheckout) {
            return classifyProvenance(obs.provenance, callerRoot, {
              verifyAgainstRoot: true,
              fineGrainedClaim,
            });
          }
          if (!callerRoot && sameProject && mustUseCallerCheckout) {
            return unverifiable(obs.provenance);
          }
        }

        // Unscoped/all-project search verifies a result against its OWN known
        // checkout, never the caller's unrelated cwd.
        const provenanceRoot = usableCheckoutRoot(obs.provenance?.cwd);
        if (provenanceRoot) {
          return classifyProvenance(obs.provenance, provenanceRoot, {
            fineGrainedClaim,
          });
        }

        const directRoot =
          usableCheckoutRoot(identity.captureCwd) ??
          usableCheckoutRoot(identity.projectPath);
        if (directRoot) {
          return classifyProvenance(obs.provenance, directRoot, {
            verifyAgainstRoot: true,
            fineGrainedClaim,
          });
        }

        if (identity.projectKey) {
          const alternate = (await loadAllSessions()).find((candidate) => {
            const candidateIdentity = sessionProjectIdentity(candidate);
            return (
              candidateIdentity.projectKey === identity.projectKey &&
              (usableCheckoutRoot(candidateIdentity.captureCwd) !== null ||
                usableCheckoutRoot(candidateIdentity.projectPath) !== null)
            );
          });
          const alternateIdentity = alternate
            ? sessionProjectIdentity(alternate)
            : undefined;
          const alternateRoot = alternateIdentity
            ? usableCheckoutRoot(alternateIdentity.captureCwd) ??
              usableCheckoutRoot(alternateIdentity.projectPath)
            : null;
          if (alternateRoot) {
            return classifyProvenance(obs.provenance, alternateRoot, {
              verifyAgainstRoot: true,
              fineGrainedClaim,
            });
          }
        }

        // A recorded-but-missing capture checkout makes both relative and
        // checkout-internal absolute paths unverifiable: absence of the whole
        // checkout is not evidence that the referenced source itself drifted.
        if (obs.provenance?.cwd && isAbsolute(obs.provenance.cwd)) {
          return unverifiable(obs.provenance);
        }
        // With no recorded checkout, absolute evidence identifies its own path
        // and can still be checked directly. Relative evidence cannot.
        return needsRelativeRoot
          ? unverifiable(obs.provenance)
          : classifyProvenance(obs.provenance, "/", { fineGrainedClaim });
      };

      // Scope, classify, THEN apply inclusion policy while filling. Every item
      // that survives already has the verdict its serializer will expose.
      const enriched: SearchResult[] = [];
      const verdictByObs = new Map<string, SearchVerdict>();
      const lifecycleByObs = new Map<string, RecallLifecycleContext>();
      let asOfUnavailable = 0;
      let asOfOutsideValidity = 0;
      let refusedCount = 0;
      // Evidence only (id + verdict), never title/content: refused content must
      // not ride back to the model inside its own refusal notice.
      const refusalSamples: Array<{
        obsId: string;
        reason: string;
        status: string;
      }> = [];
      for (const r of results) {
        if (enriched.length >= effectiveLimit) break;
        const source = await loadCandidateSource(r);
        if (!source) {
          if (currentPolicy) {
            refusedCount++;
            if (refusalSamples.length < 5) {
              refusalSamples.push({
                obsId: r.obsId,
                reason: "the indexed source is no longer recallable",
                status: "unavailable",
              });
            }
          }
          continue;
        }

        let identity: ProjectIdentity;
        if (source.memory) {
          identity = await loadMemoryIdentity(source.memory);
          // Legacy provenance may rely on a source session for its cwd.
          source.observation = memoryToObservation(source.memory, identity);
        } else {
          const session = await loadSession(r.sessionId);
          identity = session ? sessionProjectIdentity(session) : {};
        }

        if (filtering) {
          if (!hasProjectIdentity(identity)) {
            if (inclusionMode !== "legacy") {
              if (currentPolicy) {
                refusedCount++;
                if (refusalSamples.length < 5) {
                  refusalSamples.push({
                    obsId: r.obsId,
                    reason: "the record has no project identity for scoped recall",
                    status: "unverifiable",
                  });
                }
              }
              continue;
            }
          } else {
            if (
              projectFilter &&
              !projectIdentityMatchesPath(identity, projectFilter)
            ) {
              continue;
            }
            if (cwdFilter && !projectIdentityMatchesPath(identity, cwdFilter)) {
              continue;
            }
          }
        }

        const obs = source.observation;
        const verdict = await classifyForSearch(obs, identity, source.memory);
        const sourceStatus = sourceStatusOf(verdict);
        const projection = lifecycleProjection(
          source.memory,
          verdict.sourceStatus,
          verdict.status === "unverifiable" ||
            (verdict.evidenceTrust === "verified" &&
              verdict.sourceStatus === "unknown"),
        );
        let asOf: AsOfLifecycleResult | undefined;

        let included = true;
        if (inclusionMode === "current") {
          included =
            projection.effective === "active" &&
            verdict.status !== "unverifiable" &&
            verdict.sourceStatus !== "drifted" &&
            verdict.sourceStatus !== "missing" &&
            (getRecallPolicy() !== "verified-only" ||
              (verdict.evidenceTrust === "verified" &&
                (verdict.status === "verified" ||
                  verdict.status === "cosmetic")));
        } else if (inclusionMode === "historical") {
          included = projection.effective !== "active";
        } else if (inclusionMode === "as_of") {
          if (!source.memory || !asOfIso) {
            asOfUnavailable++;
            included = false;
          } else {
            asOf = evaluateMemoryAsOf(source.memory, asOfIso);
            if (!asOf.available) asOfUnavailable++;
            else if (!asOf.active) asOfOutsideValidity++;
            included = asOf.available && asOf.active;
          }
        }
        if (included && trustFilter !== null) {
          included = trustFilter.has(sourceStatus);
        }

        if (!included) {
          if (currentPolicy) {
            refusedCount++;
            if (refusalSamples.length < 5) {
              refusalSamples.push({
                obsId: obs.id,
                reason:
                  projection.effective !== "active"
                    ? projection.effectiveReason
                    : verdict.reason,
                status:
                  projection.effective !== "active"
                    ? projection.effective
                    : verdict.status,
              });
            }
          }
          continue;
        }

        verdictByObs.set(obs.id, verdict);
        lifecycleByObs.set(obs.id, {
          memory: source.memory,
          projection,
          ...(asOf ? { asOf } : {}),
        });
        enriched.push({
          observation: obs,
          score: r.score,
          sessionId: r.sessionId,
        });
      }

      if (currentPolicy && refusedCount > 0) {
        logger.info("Verified Recall refused non-current results", {
          refused: refusedCount,
        });
      }
      // mode=current is a firewall-gated model-facing recall just like the
      // safe_only compatibility path, so it contributes honest status metrics.
      if (currentPolicy) {
        // The recorder swallows storage failures, so awaiting makes the status
        // evidence observable when this request completes without adding a new
        // recall failure mode.
        await recordFirewallActivity(kv, {
          recall: true,
          refused: refusedCount,
          injected: enriched.length,
        });
      }
      const firewallMeta = currentPolicy
        ? { refused: refusedCount, samples: refusalSamples }
        : undefined;
      if (
        policyFiltering &&
        enriched.length < effectiveLimit &&
        results.length >= fetchLimit
      ) {
        logger.warn("Search policy scan window exhausted; eligible results may exist beyond it", {
          scanned: results.length,
          fetchLimit,
          mode: inclusionMode,
        });
      }

      // Recall never silently drops a memory on a fuzzy contradiction heuristic.
      // Trust/source classification and the explicit mode are the only filters.
      const recallResults = enriched;

      void recordAccessBatch(
        kv,
        recallResults.map((r) => r.observation.id),
      );

      const estimateTokens = (value: unknown): number =>
        Math.max(1, Math.ceil(JSON.stringify(value).length / 3));

      const applyTokenBudget = <T>(
        items: T[],
      ): { items: T[]; used: number; truncated: boolean } => {
        if (!tokenBudget)
          return {
            items,
            used: items.reduce((sum, item) => sum + estimateTokens(item), 0),
            truncated: false,
          };
        const selected: T[] = [];
        let used = 0;
        for (const item of items) {
          const itemTokens = estimateTokens(item);
          if (used + itemTokens > tokenBudget) {
            return {
              items: selected,
              used,
              truncated: selected.length < items.length,
            };
          }
          selected.push(item);
          used += itemTokens;
        }
        return { items: selected, used, truncated: false };
      };

      const modeMeta = inclusionMode === "legacy" ? {} : { mode: inclusionMode };
      const asOfMeta =
        inclusionMode === "as_of"
          ? {
              as_of: {
                at: asOfIso!,
                reconstruction: "stored-validity-intervals-only",
                unavailable: asOfUnavailable,
                outside_validity: asOfOutsideValidity,
                scanned: results.length,
                scan_cap: combinedFetchLimit,
                note:
                  "Oplog payload hashes are commitments, not content history; observations without stored version intervals are excluded rather than reconstructed.",
              },
            }
          : {};
      if (format === "compact") {
        const compactResults: CompactRecallItem[] = recallResults.map((r) =>
          serializeRecallItem(
            r,
            "compact",
            verdictByObs.get(r.observation.id)!,
            lifecycleByObs.get(r.observation.id)!,
          ),
        );
        const packed = applyTokenBudget(compactResults);
        return {
          format,
          ...modeMeta,
          ...asOfMeta,
          results: packed.items,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(firewallMeta ? { firewall: firewallMeta } : {}),
        };
      }

      if (format === "narrative") {
        const narrativeResults = recallResults.map((r) =>
          serializeRecallItem(
            r,
            "narrative",
            verdictByObs.get(r.observation.id)!,
            lifecycleByObs.get(r.observation.id)!,
          ),
        );
        const packed = applyTokenBudget(narrativeResults);
        const text = packed.items.map(formatNarrativeItem).join("\n\n");
        return {
          format,
          ...modeMeta,
          ...asOfMeta,
          results: packed.items,
          text,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(firewallMeta ? { firewall: firewallMeta } : {}),
        };
      }

      const fullResults: FullRecallItem[] = recallResults.map((r) =>
        serializeFullRecallItem(
          r,
          verdictByObs.get(r.observation.id)!,
          lifecycleByObs.get(r.observation.id)!,
        ),
      );
      const packed = applyTokenBudget(fullResults);

      // Avoid logging raw cwd/project (host paths). Log only that filters
      // were active.
      logger.info("Search completed", {
        query,
        results: packed.items.length,
        hasProjectFilter: !!projectFilter,
        hasCwdFilter: !!cwdFilter,
      });
      return {
        format,
        ...modeMeta,
        ...asOfMeta,
        results: packed.items,
        tokens_used: packed.used,
        tokens_budget: tokenBudget,
        truncated: packed.truncated,
        ...(firewallMeta ? { firewall: firewallMeta } : {}),
      };
    },
  );
}
