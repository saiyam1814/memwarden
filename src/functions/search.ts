//
// BM25 keyword search (mem::search). Ported from the original
// src/functions/search.ts. The BM25-only retrieval path, the lazy
// index-rebuild, the project/cwd over-fetch + post-filter, the
// memory-scope fallback, and the three output formats (full / compact /
// narrative) with token-budget packing are preserved with identical
// validation and wire shapes.
//
// PHASE-0 SCOPE: no embedding provider is wired, so vectorIndexAddGuarded
// is a no-op soft-fail (its signature is kept because observe.ts calls it),
// and rebuildIndex only repopulates the BM25 index. The batched embed flush
// and IndexPersistence sync hooks from the predecessor are intentionally
// dropped until the vector provider lands in Phase 0b.

import type { ISdk } from "../kernel/index.js";
import type {
  CompactSearchResult,
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
} from "./config.js";
import { memoryToObservation } from "./memory-utils.js";
import { canonicalizePath } from "./paths.js";
import { recordAccessBatch } from "./access-tracker.js";
import { loadVectorIndex, persistVectorIndex } from "./vector-persistence.js";
import { logger } from "./logger.js";
import { metrics } from "../observability/metrics.js";

let index: SearchIndex | null = null;
let vectorIndex: VectorIndexLike | null = null;
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
// never breaks the upstream save. In Phase 0 no provider is wired, so this
// returns false immediately; observe.ts treats false as "vector skipped",
// not an error.
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

// Rebuilds the BM25 index from KV. Walks the memories scope (so
// mem::remember entries survive a restart) and every session's
// observations. The vector index is cleared in lockstep so BM25 and vector
// stay in sync; in Phase 0 it stays empty (no provider). When a persisted
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
        await vectorIndexAddGuarded(
          memory.id,
          memory.sessionIds?.[0] ?? "memory",
          memory.title + " " + memory.content,
          { kind: "memory", logId: memory.id },
        );
      }
      count++;
    }
  } catch (err) {
    logger.warn("rebuildIndex: failed to load memories", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sessions = await kv.list<Session>(KV.sessions);
  if (!sessions.length) {
    evictGhostVectors(liveIds);
    return count;
  }

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
          await vectorIndexAddGuarded(obs.id, obs.sessionId, obs.title + " " + obs.narrative, {
            kind: "observation",
            logId: obs.id,
          });
        }
        count++;
      }
    }
  }

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

      if (idx.size === 0) {
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
        logger.info("Search index rebuilt", {
          entries: count,
          restoredVectors,
          persisted,
        });
      }

      // When filtering by project/cwd, over-fetch from the index so the
      // post-filter still has a chance of returning `effectiveLimit`
      // results.
      const filtering = !!(projectFilter || cwdFilter);
      const fetchLimit = filtering
        ? Math.max(effectiveLimit * 10, 100)
        : effectiveLimit;
      // Measure retrieval itself (not the one-time cold rebuild above) — the
      // "is finding context fast?" number.
      const searchStartedAt = performance.now();
      const bm25Results = idx.search(query, fetchLimit);
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
            results = fuseRrf(bm25Results, vIdx.search(qVec, fetchLimit), fetchLimit);
          }
        } catch (err) {
          logger.warn("search: vector stream failed — BM25 only", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      metrics.recordSearch(performance.now() - searchStartedAt);

      // Resolve session -> project/cwd once per sessionId we touch.
      const sessionCache = new Map<string, Session | null>();
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

      // First pass: filter by session (sequential — benefits from session
      // cache). Memory entries with a synthetic sessionId take a secondary
      // KV.memories path so project filtering works for them too.
      const candidates: typeof results = [];
      for (const r of results) {
        if (candidates.length >= effectiveLimit) break;
        if (filtering) {
          const s = await loadSession(r.sessionId);
          if (s) {
            if (projectFilter && canonicalizePath(s.project) !== projectFilter)
              continue;
            if (cwdFilter && canonicalizePath(s.cwd) !== cwdFilter) continue;
          } else {
            // Session not found: synthetic sessionId (memory) or a deleted
            // session. A null memProject means "project unknown — treat as
            // unscoped and let it through" for backward-compatibility.
            if (projectFilter) {
              const memProject = await loadMemoryProject(r.obsId);
              if (
                memProject !== null &&
                canonicalizePath(memProject) !== projectFilter
              )
                continue;
            }
            // cwd filter does not apply to unbound entries.
          }
        }
        candidates.push(r);
      }

      // Second pass: load observations in parallel. Fall back to KV.memories
      // when the observation lookup misses (entries indexed via
      // mem::remember live in the memories scope under a synthetic
      // sessionId, so the observation key never exists).
      const obsResults = await Promise.all(
        candidates.map(async (r) => {
          const obs = await kv
            .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
            .catch(() => null);
          if (obs) return obs;
          const mem = await kv
            .get<Memory>(KV.memories, r.obsId)
            .catch(() => null);
          return mem ? memoryToObservation(mem) : null;
        }),
      );
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

      void recordAccessBatch(
        kv,
        enriched.map((r) => r.observation.id),
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
        const compactResults: CompactSearchResult[] = enriched.map((r) => ({
          obsId: r.observation.id,
          sessionId: r.sessionId,
          title: r.observation.title,
          type: r.observation.type,
          score: r.score,
          timestamp: r.observation.timestamp,
        }));
        const packed = applyTokenBudget(compactResults);
        return {
          format,
          results: packed.items,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
        };
      }

      if (format === "narrative") {
        const narrativeResults = enriched.map((r) => ({
          obsId: r.observation.id,
          sessionId: r.sessionId,
          title: r.observation.title,
          narrative: r.observation.narrative,
          score: r.score,
          timestamp: r.observation.timestamp,
        }));
        const packed = applyTokenBudget(narrativeResults);
        const text = packed.items
          .map((r, idxN) => `${idxN + 1}. ${r.title}\n${r.narrative}`)
          .join("\n\n");
        return {
          format,
          results: packed.items,
          text,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
        };
      }

      const packed = applyTokenBudget(enriched);

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
      };
    },
  );
}
