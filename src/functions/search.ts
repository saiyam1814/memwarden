//
// Search (mem::search): hybrid BM25 + vector (RRF) retrieval with a lazy index
// rebuild, project/cwd over-fetch + canonical-path post-filter, a memory-scope
// fallback, an optional Verified Recall firewall (safe_only), and three output
// formats (full / compact / narrative) with token-budget packing. When an
// embedding provider is active (the default: on-device MiniLM + TurboQuant)
// the vector stream is fused in; with no provider it runs BM25-only.

import type { ISdk } from "../kernel/index.js";
import type {
  CompressedObservation,
  Memory,
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
import { memoryToObservation } from "./memory-utils.js";
import { canonicalizePath } from "./paths.js";
import { gitProjectKey } from "./git-identity.js";
import { classifyProvenance, type Verdict } from "./verify.js";
import { recordAccessBatch } from "./access-tracker.js";
import { loadVectorIndex, persistVectorIndex } from "./vector-persistence.js";
import { logger } from "./logger.js";
import { metrics } from "../observability/metrics.js";

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
      if (memory.isLatest === false) continue;
      if (!memory.title || !memory.content) continue;
      idx.add(memoryToObservation(memory));
      liveIds?.add(memory.id);
      if (!preserveVectors || !vectorIndex?.has(memory.id)) {
        pending.push({
          id: memory.id,
          sessionId: memory.sessionIds?.[0] ?? "memory",
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
  const inScope = (s: Session): boolean => {
    if (
      scope.projectFilter &&
      !(s.projectKey !== undefined && s.projectKey === scope.projectFilterKey) &&
      canonicalizePath(s.project) !== scope.projectFilter
    )
      return false;
    if (
      scope.cwdFilter &&
      !(s.projectKey !== undefined && s.projectKey === scope.cwdFilterKey) &&
      canonicalizePath(s.cwd) !== scope.cwdFilter
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
  return { allowed, sessions };
}

// --- recall serialization (labeled) ---------------------------------
//
// Balanced recall injects sourced/unsourced memory BY DESIGN, and the
// promise (README, SECURITY.md) is that it arrives LABELED. This is the ONE
// serializer for recall output — compact and narrative both go through it —
// and it attaches the trust verdict the safe_only firewall pass already
// computed (never reclassified a second time). `trust` is absent only when
// no verdict exists, i.e. a plain non-safe_only search.

export type TrustLabel = "verified" | "sourced" | "unsourced" | "stale";

export function trustLabelOf(verdict: Verdict): TrustLabel {
  switch (verdict.status) {
    case "verified":
      return "verified";
    case "sourced_unverified":
      return "sourced";
    case "stale":
      return "stale";
    case "unsourced":
      return "unsourced";
  }
}

interface RecallItemBase {
  obsId: string;
  sessionId: string;
  title: string;
  score: number;
  timestamp: string;
  trust?: TrustLabel;
}
export interface CompactRecallItem extends RecallItemBase {
  type: CompressedObservation["type"];
}
export interface NarrativeRecallItem extends RecallItemBase {
  narrative: string;
}

export function serializeRecallItem(
  r: SearchResult,
  format: "compact",
  verdict?: Verdict,
): CompactRecallItem;
export function serializeRecallItem(
  r: SearchResult,
  format: "narrative",
  verdict?: Verdict,
): NarrativeRecallItem;
export function serializeRecallItem(
  r: SearchResult,
  format: "compact" | "narrative",
  verdict?: Verdict,
): CompactRecallItem | NarrativeRecallItem {
  const base: RecallItemBase = {
    obsId: r.observation.id,
    sessionId: r.sessionId,
    title: r.observation.title,
    score: r.score,
    timestamp: r.observation.timestamp,
    ...(verdict ? { trust: trustLabelOf(verdict) } : {}),
  };
  return format === "compact"
    ? { ...base, type: r.observation.type }
    : { ...base, narrative: r.observation.narrative };
}

/** One narrative line, label first — the text surfaces (hooks, proxy, MCP
 * resume) inject exactly this, so the label travels with the memory. */
export function formatNarrativeItem(
  item: NarrativeRecallItem,
  idx: number,
): string {
  const label = item.trust ? `[${item.trust}] ` : "";
  return `${idx + 1}. ${label}${item.title}\n${item.narrative}`;
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
    }) => {
      const idx = getSearchIndex();

      // Input validation / normalization.
      if (typeof data?.query !== "string" || !data.query.trim()) {
        throw new Error("mem::search: query must be a non-empty string");
      }
      const query = data.query.trim();
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
      // repo root). Used below to WIDEN the path filters — same key at a
      // different path (another worktree, a moved checkout) still matches.
      const projectFilterKey =
        projectFilter !== undefined ? gitProjectKey(projectFilter) : null;
      const cwdFilterKey = cwdFilter !== undefined ? gitProjectKey(cwdFilter) : null;
      // Verified Recall firewall: when on (recall surfaces default it on),
      // drop results that reference files now deleted or content-changed, so
      // stale memory is never injected. It needs a cwd to check against — and
      // it FAILS CLOSED: asking for safe_only without a cwd is an error, not a
      // silent downgrade to unfiltered results. Enforced here at the function
      // boundary (not just the HTTP route) so no in-process caller can lose
      // the firewall by omitting cwd.
      const wantsSafeOnly = (data as { safe_only?: unknown }).safe_only === true;
      if (wantsSafeOnly && cwdFilter === undefined) {
        throw new Error(
          "mem::search: safe_only requires a cwd to verify memory against (the firewall fails closed)",
        );
      }
      const safeOnly = wantsSafeOnly && cwdFilter !== undefined;
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

      // When filtering by project/cwd, over-fetch from the index so the
      // post-filter still has a chance of returning `effectiveLimit` results.
      // safe_only over-fetches much harder (and caps at SAFE_SCAN_CAP) so a run
      // of stale high-ranking hits is unlikely to starve a verified result; if
      // the scan window is exhausted we log it rather than hide it.
      const SAFE_SCAN_CAP = 2000;
      const filtering = !!(projectFilter || cwdFilter);
      const fetchLimit = safeOnly
        ? Math.min(SAFE_SCAN_CAP, Math.max(effectiveLimit * 50, 500))
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
      const bm25Results = scopedAllowed
        ? idx.search(query, fetchLimit, scopedAllowed)
        : idx.search(query, fetchLimit);
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
            results = fuseRrf(bm25Results, vectorHits, fetchLimit);
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

      // Cache for memory project lookups. Memories indexed via mem::remember
      // use a synthetic sessionId that either has no KV.sessions entry or
      // belongs to a different project. When loadSession returns null we
      // fall through to a KV.memories probe so project-filtered search can
      // include or exclude them correctly.
      const memoryProjectCache = new Map<string, string | null>();
      const loadMemoryProject = async (
        obsId: string,
      ): Promise<string | null> => {
        if (memoryProjectCache.has(obsId))
          return memoryProjectCache.get(obsId)!;
        const mem = await kv
          .get<Memory>(KV.memories, obsId)
          .catch(() => null);
        const proj = mem?.project ?? null;
        memoryProjectCache.set(obsId, proj);
        return proj;
      };

      // A candidate's observation (or a memory rendered as one). Cached so the
      // Verified Recall firewall and the final assembly never load it twice.
      const obsCache = new Map<string, CompressedObservation | null>();
      const loadObsOrMemory = async (r: {
        obsId: string;
        sessionId: string;
      }): Promise<CompressedObservation | null> => {
        if (obsCache.has(r.obsId)) return obsCache.get(r.obsId)!;
        let obs = await kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (!obs) {
          const mem = await kv.get<Memory>(KV.memories, r.obsId).catch(() => null);
          obs = mem ? memoryToObservation(mem) : null;
        }
        obsCache.set(r.obsId, obs);
        return obs;
      };

      // First pass: scope-filter, and — when safe_only is on — apply the
      // Verified Recall firewall WHILE filling, so stale top hits don't starve
      // out lower-ranked verified ones. We keep scanning the fetched results
      // (fetchLimit, up to SAFE_SCAN_CAP) until we have effectiveLimit safe ones.
      const candidateTarget = safeOnly
        ? Math.min(fetchLimit, Math.max(effectiveLimit * 3, effectiveLimit + 20))
        : effectiveLimit;
      const candidates: typeof results = [];
      // Verdicts computed by the firewall pass, kept so the serializer can
      // label recall output without classifying twice.
      const verdictByObs = new Map<string, Verdict>();
      let staleDropped = 0;
      // Samples the SessionStart hook (and `memwarden why`) can surface so the
      // user *sees* the firewall work — not just silent omission. Evidence
      // only (id + verdict), never the title: a refused observation's title
      // carries its content (a handoff title embeds the user's prompt), and
      // refused content must not ride back to the model inside the refusal
      // notice. `memwarden why <obsId>` is the inspection path.
      const refusalSamples: Array<{
        obsId: string;
        reason: string;
        status: string;
      }> = [];
      for (const r of results) {
        if (candidates.length >= candidateTarget) break;
        if (filtering) {
          const s = await loadSession(r.sessionId);
          if (s) {
            // Project identity WIDENS (never replaces) the path filters: a
            // session whose stored projectKey matches the query directory's
            // key is the same project even at a different path (another git
            // worktree, a moved checkout). Sessions without a key — all
            // pre-existing data — keep the exact path-match behavior.
            if (
              projectFilter &&
              !(s.projectKey !== undefined && s.projectKey === projectFilterKey) &&
              canonicalizePath(s.project) !== projectFilter
            )
              continue;
            if (
              cwdFilter &&
              !(s.projectKey !== undefined && s.projectKey === cwdFilterKey) &&
              canonicalizePath(s.cwd) !== cwdFilter
            )
              continue;
          } else if (projectFilter) {
            // Synthetic/memory entry: a null memProject means "unknown" and is
            // let through for backward-compatibility; cwd filter doesn't apply.
            const memProject = await loadMemoryProject(r.obsId);
            if (
              memProject !== null &&
              canonicalizePath(memProject) !== projectFilter
            )
              continue;
          }
        }
        if (safeOnly && cwdFilter) {
          const obs = await loadObsOrMemory(r);
          // Fail closed for stale/missing candidates. Sourced-unverified memory
          // is allowed by design, but stale memory never gets injected.
          // When the memory's stable projectKey matches the caller's, verify
          // against the CALLER's checkout — a widened result from another
          // worktree must be checked against the files the agent is actually
          // looking at, not the (possibly diverged or deleted) capture dir.
          const obsSession = await loadSession(r.sessionId);
          const verdict = !obs
            ? null
            : classifyProvenance(obs.provenance, cwdFilter, {
                verifyAgainstRoot:
                  obsSession?.projectKey !== undefined &&
                  obsSession.projectKey === cwdFilterKey,
              });
          // Policy floor: `balanced` (default) drops only detected-stale;
          // `verified-only` additionally refuses everything that is not
          // hash-verified against the live checkout — the strict answer to
          // memory poisoning via unsourced/unverifiable content (OWASP ASI06).
          const dropUnderPolicy =
            !verdict ||
            verdict.status === "stale" ||
            (getRecallPolicy() === "verified-only" &&
              verdict.status !== "verified");
          if (dropUnderPolicy || !verdict) {
            staleDropped++;
            if (obs && verdict && refusalSamples.length < 5) {
              refusalSamples.push({
                obsId: obs.id,
                reason: verdict.reason,
                status: verdict.status,
              });
            }
            continue;
          }
          verdictByObs.set(r.obsId, verdict);
        }
        candidates.push(r);
      }
      if (safeOnly && staleDropped > 0) {
        logger.info("Verified Recall dropped stale results", { dropped: staleDropped });
      }
      const firewallMeta = safeOnly
        ? { refused: staleDropped, samples: refusalSamples }
        : undefined;
      // No silent cap: if we ran out of safe candidates AND exhausted the scan
      // window, a verified result could exist beyond it — say so.
      if (
        safeOnly &&
        candidates.length < effectiveLimit &&
        results.length >= fetchLimit
      ) {
        logger.warn("Verified Recall scan window exhausted; verified results may exist beyond it", {
          scanned: results.length,
          fetchLimit,
        });
      }

      // Second pass: assemble results, reusing any observation loaded above.
      const obsResults = await Promise.all(candidates.map((c) => loadObsOrMemory(c)));
      const enriched: SearchResult[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const obs = obsResults[i];
        const cand = candidates[i]!;
        if (obs) {
          enriched.push({
            observation: obs,
            score: cand.score,
            sessionId: cand.sessionId,
          });
        }
      }

      // Safe recall NEVER silently drops a memory on a fuzzy contradiction
      // heuristic — that would lose correct facts from a trust tool. The only
      // thing safe_only firewalls is STALE memory (handled above, when the
      // referenced files are deleted/changed). Conflict detection is advisory
      // only and lives in mem::doctor, not in recall.
      const recallResults = enriched.slice(0, effectiveLimit);

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

      if (format === "compact") {
        const compactResults: CompactRecallItem[] = recallResults.map((r) =>
          serializeRecallItem(r, "compact", verdictByObs.get(r.observation.id)),
        );
        const packed = applyTokenBudget(compactResults);
        return {
          format,
          results: packed.items,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(firewallMeta ? { firewall: firewallMeta } : {}),
        };
      }

      if (format === "narrative") {
        const narrativeResults = recallResults.map((r) =>
          serializeRecallItem(r, "narrative", verdictByObs.get(r.observation.id)),
        );
        const packed = applyTokenBudget(narrativeResults);
        const text = packed.items.map(formatNarrativeItem).join("\n\n");
        return {
          format,
          results: packed.items,
          text,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
          ...(firewallMeta ? { firewall: firewallMeta } : {}),
        };
      }

      const packed = applyTokenBudget(recallResults);

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
        results: packed.items,
        tokens_used: packed.used,
        tokens_budget: tokenBudget,
        truncated: packed.truncated,
        ...(firewallMeta ? { firewall: firewallMeta } : {}),
      };
    },
  );
}
