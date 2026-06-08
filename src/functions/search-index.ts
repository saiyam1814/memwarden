//
// Okapi BM25 inverted index. Pure and engine-independent. BM25 is a published
// ranking function; the standard constants (k1 = 1.2, b = 0.75) and the
// idf = log((N - df + 0.5)/(df + 0.5) + 1) form are used as published. On top
// of exact terms, query terms also match by prefix (binary-searched over the
// sorted term list, contribution halved) and via synonym expansion (synonym
// terms enter at weight 0.7).

import type { CompressedObservation } from "./types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
}

export interface Bm25Hit {
  obsId: string;
  sessionId: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

export class SearchIndex {
  private docs = new Map<string, IndexEntry>(); // obsId -> entry
  private postings = new Map<string, Set<string>>(); // term -> obsIds
  private termFreqs = new Map<string, Map<string, number>>(); // obsId -> term -> tf
  private totalLength = 0;
  private sortedTermsCache: string[] | null = null;

  add(obs: CompressedObservation): void {
    const terms = this.extractTerms(obs);
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);

    this.docs.set(obs.id, {
      obsId: obs.id,
      sessionId: obs.sessionId,
      termCount: terms.length,
    });
    this.termFreqs.set(obs.id, tf);
    this.totalLength += terms.length;
    for (const term of tf.keys()) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, (posting = new Set()));
      posting.add(obs.id);
    }
    this.sortedTermsCache = null;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  remove(id: string): void {
    const entry = this.docs.get(id);
    if (!entry) return;
    const tf = this.termFreqs.get(id);
    if (tf) {
      for (const term of tf.keys()) {
        const posting = this.postings.get(term);
        if (posting) {
          posting.delete(id);
          if (posting.size === 0) this.postings.delete(term);
        }
      }
      this.termFreqs.delete(id);
    }
    this.totalLength = Math.max(0, this.totalLength - entry.termCount);
    this.docs.delete(id);
    this.sortedTermsCache = null;
  }

  get size(): number {
    return this.docs.size;
  }

  // BM25 contribution of a single term to a single document (no query weight).
  private contribution(tf: number, df: number, n: number, docLen: number, avgLen: number): number {
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    const num = tf * (K1 + 1);
    const den = tf + K1 * (1 - B + B * (docLen / avgLen));
    return idf * (num / den);
  }

  search(query: string, limit = 20): Bm25Hit[] {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];
    const n = this.docs.size;
    if (n === 0) return [];
    const avgLen = this.totalLength / n;

    // exact terms at full weight, synonyms at 0.7, de-duplicated
    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const accrue = (term: string, weight: number, factor: number): void => {
      const posting = this.postings.get(term);
      if (!posting) return;
      const df = posting.size;
      for (const obsId of posting) {
        const doc = this.docs.get(obsId)!;
        const tf = this.termFreqs.get(obsId)?.get(term) ?? 0;
        const add = this.contribution(tf, df, n, doc.termCount, avgLen) * weight * factor;
        scores.set(obsId, (scores.get(obsId) ?? 0) + add);
      }
    };

    const sorted = this.sortedTerms();
    for (const { term, weight } of queryTerms) {
      accrue(term, weight, 1); // exact match
      // prefix matches (term*) excluding the exact term, contribution halved
      for (let i = this.lowerBound(sorted, term); i < sorted.length; i++) {
        const candidate = sorted[i];
        if (candidate === undefined || !candidate.startsWith(term)) break;
        if (candidate === term) continue;
        accrue(candidate, weight, 0.5);
      }
    }

    return [...scores.entries()]
      .map(([obsId, score]) => ({
        obsId,
        sessionId: this.docs.get(obsId)!.sessionId,
        score,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.termFreqs.clear();
    this.totalLength = 0;
    this.sortedTermsCache = null;
  }

  restoreFrom(other: SearchIndex): void {
    this.docs = new Map([...other.docs].map(([k, v]) => [k, { ...v }]));
    this.postings = new Map([...other.postings].map(([k, v]) => [k, new Set(v)]));
    this.termFreqs = new Map([...other.termFreqs].map(([k, v]) => [k, new Map(v)]));
    this.totalLength = other.totalLength;
    this.sortedTermsCache = null;
  }

  serialize(): string {
    return JSON.stringify({
      v: 2,
      entries: [...this.docs.entries()],
      inverted: [...this.postings.entries()].map(
        ([term, ids]) => [term, [...ids]] as [string, string[]],
      ),
      docTerms: [...this.termFreqs.entries()].map(
        ([id, counts]) => [id, [...counts.entries()]] as [string, [string, number][]],
      ),
      totalDocLength: this.totalLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    const idx = new SearchIndex();
    try {
      const data = JSON.parse(json) as {
        entries?: Array<[string, IndexEntry]>;
        inverted?: Array<[string, string[]]>;
        docTerms?: Array<[string, Array<[string, number]>]>;
        totalDocLength?: unknown;
      };
      if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
      for (const [id, entry] of data.entries) idx.docs.set(id, entry);
      for (const [term, ids] of data.inverted) idx.postings.set(term, new Set(ids));
      for (const [id, counts] of data.docTerms) idx.termFreqs.set(id, new Map(counts));
      const len = Number(data.totalDocLength);
      idx.totalLength = Number.isFinite(len) && len >= 0 ? Math.floor(len) : 0;
    } catch {
      return new SearchIndex();
    }
    return idx;
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle ?? "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const tokens: string[] = [];
    for (const word of cleaned.split(/\s+/)) {
      if (word.length < 2) continue;
      if (hasCjk(word)) {
        for (const seg of segmentCjk(word)) if (seg.length >= 1) tokens.push(seg);
      } else {
        tokens.push(stem(word));
      }
    }
    return tokens;
  }

  private sortedTerms(): string[] {
    return (this.sortedTermsCache ??= [...this.postings.keys()].sort());
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((arr[mid] ?? "") < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
