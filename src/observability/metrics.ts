//
// In-process observability for memwarden. Tracks the two numbers that
// decide whether this layer is actually good for an agent:
//
//   1. Token economy — how many tokens we save by storing compressed
//      observations and serving budgeted context instead of raw history.
//   2. Latency — how fast search and context return, so switching agents
//      never means "wait while it finds the context."
//
// Running aggregates, no I/O on the hot path. Latency keeps a bounded
// sample window for percentiles. Reset for tests. Durable persistence
// (a cost-ledger KV table) can layer on top later without changing callers.

const MAX_SAMPLES = 1000;

function estimateTokens(text: string): number {
  // Same heuristic the context packer uses (~3 chars/token). Centralized
  // here so every token number in the system comes from one place.
  return Math.ceil(text.length / 3);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] as number;
}

class Metrics {
  private observeCount = 0;
  private observeRawTokens = 0;
  private observeStoredTokens = 0;

  private contextCount = 0;
  private contextCandidateTokens = 0;
  private contextServedTokens = 0;
  private contextLatency: number[] = [];

  private searchCount = 0;
  private searchLatency: number[] = [];

  private pushSample(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > MAX_SAMPLES) arr.shift();
  }

  /** Record one observe: raw payload size vs the compressed record stored. */
  recordObserve(rawText: string, storedText: string): void {
    this.observeCount++;
    this.observeRawTokens += estimateTokens(rawText);
    this.observeStoredTokens += estimateTokens(storedText);
  }

  /**
   * Record one context build: candidate = tokens of everything that
   * matched, served = tokens actually returned under budget.
   */
  recordContext(
    candidateTokens: number,
    servedTokens: number,
    latencyMs: number,
  ): void {
    this.contextCount++;
    this.contextCandidateTokens += candidateTokens;
    this.contextServedTokens += servedTokens;
    this.pushSample(this.contextLatency, latencyMs);
  }

  recordSearch(latencyMs: number): void {
    this.searchCount++;
    this.pushSample(this.searchLatency, latencyMs);
  }

  snapshot(): Record<string, unknown> {
    const ctxSorted = [...this.contextLatency].sort((a, b) => a - b);
    const searchSorted = [...this.searchLatency].sort((a, b) => a - b);
    const pct = (saved: number, total: number) =>
      total > 0 ? Math.round((saved / total) * 1000) / 10 : 0;

    return {
      observe: {
        count: this.observeCount,
        rawTokens: this.observeRawTokens,
        storedTokens: this.observeStoredTokens,
        reductionPct: pct(
          this.observeRawTokens - this.observeStoredTokens,
          this.observeRawTokens,
        ),
      },
      context: {
        count: this.contextCount,
        candidateTokens: this.contextCandidateTokens,
        servedTokens: this.contextServedTokens,
        reductionPct: pct(
          this.contextCandidateTokens - this.contextServedTokens,
          this.contextCandidateTokens,
        ),
        latencyMs: {
          p50: Math.round(percentile(ctxSorted, 50)),
          p95: Math.round(percentile(ctxSorted, 95)),
        },
      },
      search: {
        count: this.searchCount,
        latencyMs: {
          p50: Math.round(percentile(searchSorted, 50)),
          p95: Math.round(percentile(searchSorted, 95)),
        },
      },
    };
  }

  reset(): void {
    this.observeCount = 0;
    this.observeRawTokens = 0;
    this.observeStoredTokens = 0;
    this.contextCount = 0;
    this.contextCandidateTokens = 0;
    this.contextServedTokens = 0;
    this.contextLatency = [];
    this.searchCount = 0;
    this.searchLatency = [];
  }
}

/** Process-wide metrics singleton. */
export const metrics = new Metrics();
export { estimateTokens };
