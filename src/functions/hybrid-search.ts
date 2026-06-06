//
// Reciprocal Rank Fusion (RRF) hybrid retrieval. Ported from the original
// src/state/hybrid-search.ts, preserving the load-bearing constants and the
// exact fusion math:
//
// RRF_K = 60
// default weights: bm25Weight = 0.4, vectorWeight = 0.6, graphWeight = 0.3
// combinedScore = Σ effectiveW_stream * (1 / (RRF_K + rank_stream))
// missing-stream rank = Infinity (so its term is 1/(60+Inf) = 0)
// weights are RENORMALIZED over only the streams that returned hits.
//
// PHASE-0 SCOPE: the vector and graph streams are stubbed empty (no
// embedding provider, no knowledge graph wired yet). Because the
// renormalization divides by the sum of only the streams that returned
// hits, with both vector and graph empty the BM25 stream is renormalized
// to weight 1.0 — identical to the original behavior when those streams
// return nothing. When the vector provider lands in Phase 0b, pass a real
// VectorIndex + EmbeddingProvider into the constructor and the second
// stream lights up with no fusion-math change. The graph stream stays a
// no-op until the graph layer is ported.

import { SearchIndex } from "./search-index.js";
import type {
  EmbeddingProvider,
  HybridSearchResult,
  CompressedObservation,
  Memory,
  VectorIndexLike,
} from "./types.js";
import { memoryToObservation } from "./memory-utils.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

const RRF_K = 60;

export class HybridSearch {
  constructor(
    private bm25: SearchIndex,
    private vector: VectorIndexLike | null,
    private embeddingProvider: EmbeddingProvider | null,
    private kv: StateKV,
    private bm25Weight = 0.4,
    private vectorWeight = 0.6,
    private graphWeight = 0.3,
  ) {}

  async search(query: string, limit = 20): Promise<HybridSearchResult[]> {
    return this.tripleStreamSearch(query, limit);
  }

  private async tripleStreamSearch(
    query: string,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    const bm25Results = this.bm25.search(query, limit * 2);

    // Vector stream. Stubbed empty in Phase 0 (no provider / empty index);
    // the try/catch + size-guard mirror the original implementation so lighting up the
    // provider later needs no change here.
    let vectorResults: Array<{
      obsId: string;
      sessionId: string;
      score: number;
    }> = [];
    if (this.vector && this.embeddingProvider && this.vector.size > 0) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed(query);
        vectorResults = this.vector.search(queryEmbedding, limit * 2);
      } catch {
        // fall through to BM25-only
      }
    }

    // Graph stream. Not ported in Phase 0; always empty.
    const graphResults: Array<{
      obsId: string;
      sessionId: string;
      score: number;
      graphContext?: string;
    }> = [];

    const scores = new Map<
      string,
      {
        bm25Rank: number;
        vectorRank: number;
        graphRank: number;
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        graphScore: number;
        graphContext?: string;
      }
    >();

    bm25Results.forEach((r, i) => {
      scores.set(r.obsId, {
        bm25Rank: i + 1,
        vectorRank: Infinity,
        graphRank: Infinity,
        sessionId: r.sessionId,
        bm25Score: r.score,
        vectorScore: 0,
        graphScore: 0,
      });
    });

    vectorResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.vectorRank = i + 1;
        existing.vectorScore = r.score;
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: i + 1,
          graphRank: Infinity,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: r.score,
          graphScore: 0,
        });
      }
    });

    graphResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.graphRank = Math.min(existing.graphRank, i + 1);
        existing.graphScore = Math.max(existing.graphScore, r.score);
        if (r.graphContext && !existing.graphContext) {
          existing.graphContext = r.graphContext;
        }
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: Infinity,
          graphRank: i + 1,
          sessionId: r.sessionId,
          bm25Score: 0,
          vectorScore: 0,
          graphScore: r.score,
          ...(r.graphContext !== undefined
            ? { graphContext: r.graphContext }
            : {}),
        });
      }
    });

    const hasVector = vectorResults.length > 0;
    const hasGraph = graphResults.length > 0;

    let effectiveBm25W = this.bm25Weight;
    let effectiveVectorW = hasVector ? this.vectorWeight : 0;
    let effectiveGraphW = hasGraph ? this.graphWeight : 0;

    // Renormalize over only the streams that returned hits. With both the
    // vector and graph streams empty (Phase 0) this leaves BM25 at 1.0.
    const totalW = effectiveBm25W + effectiveVectorW + effectiveGraphW;
    if (totalW > 0) {
      effectiveBm25W /= totalW;
      effectiveVectorW /= totalW;
      effectiveGraphW /= totalW;
    }

    const combined = Array.from(scores.entries()).map(([obsId, s]) => ({
      obsId,
      sessionId: s.sessionId,
      bm25Score: s.bm25Score,
      vectorScore: s.vectorScore,
      graphScore: s.graphScore,
      graphContext: s.graphContext,
      combinedScore:
        effectiveBm25W * (1 / (RRF_K + s.bm25Rank)) +
        effectiveVectorW * (1 / (RRF_K + s.vectorRank)) +
        effectiveGraphW * (1 / (RRF_K + s.graphRank)),
    }));

    combined.sort((a, b) => b.combinedScore - a.combinedScore);

    const retrievalDepth = Math.max(limit, 20);
    const diversified = this.diversifyBySession(combined, retrievalDepth);
    const enriched = await this.enrichResults(diversified, retrievalDepth);

    return enriched.slice(0, limit);
  }

  private diversifyBySession<
    T extends { obsId: string; sessionId: string },
  >(results: T[], limit: number, maxPerSession = 3): T[] {
    const selected: T[] = [];
    const sessionCounts = new Map<string, number>();

    for (const r of results) {
      const count = sessionCounts.get(r.sessionId) || 0;
      if (count >= maxPerSession) continue;
      selected.push(r);
      sessionCounts.set(r.sessionId, count + 1);
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      for (const r of results) {
        if (selected.length >= limit) break;
        if (!selected.some((s) => s.obsId === r.obsId)) {
          selected.push(r);
        }
      }
    }

    return selected;
  }

  private async enrichResults(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string | undefined;
    }>,
    limit: number,
  ): Promise<HybridSearchResult[]> {
    const sliced = results.slice(0, limit);
    const observations = await Promise.all(
      sliced.map(async (r) => {
        const obs = await this.kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (obs) return obs;
        // Fallback: indexed entry may originate from mem::remember, which
        // writes to KV.memories with a synthetic sessionId. Coerce the
        // Memory record into a CompressedObservation so saved memories
        // still surface.
        const mem = await this.kv
          .get<Memory>(KV.memories, r.obsId)
          .catch(() => null);
        return mem ? memoryToObservation(mem) : null;
      }),
    );
    const enriched: HybridSearchResult[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const obs = observations[i];
      const src = sliced[i]!;
      if (obs) {
        enriched.push({
          observation: obs,
          bm25Score: src.bm25Score,
          vectorScore: src.vectorScore,
          graphScore: src.graphScore,
          combinedScore: src.combinedScore,
          sessionId: src.sessionId,
          ...(src.graphContext !== undefined
            ? { graphContext: src.graphContext }
            : {}),
        });
      }
    }
    return enriched;
  }
}
