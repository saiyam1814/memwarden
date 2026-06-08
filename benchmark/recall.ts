//
// memwarden recall benchmark. Runs the REAL on-device embedding model
// (all-MiniLM-L6-v2) over a small coding-memory corpus whose queries are
// phrased with DIFFERENT words than the answers, so it measures semantic
// recall, not keyword overlap. Reports:
//
//   - recall@k for full-precision vs TurboQuant (does compression hurt?)
//   - recall@k for a lexical baseline (does meaning-search beat keywords?)
//   - compression ratio and search latency
//
// Run: npx tsx benchmark/recall.ts
// Honest by construction: same embeddings feed every index; ground truth is
// the labelled gold answer per query.

import { VectorIndex } from "../src/functions/vector-index.js";
import { QuantizedVectorIndex } from "../src/functions/quantized-vector-index.js";
import { LocalEmbeddingProvider } from "../src/embedding/local-embedding.js";

interface Doc {
  id: string;
  text: string;
}

// 30 coding memories across distinct topics.
const CORPUS: Doc[] = [
  { id: "auth-iam", text: "switched the auth module to IAM bearer tokens, dropped session cookies" },
  { id: "auth-jose", text: "we chose the jose library over jsonwebtoken for Edge runtime compatibility" },
  { id: "auth-refresh", text: "refresh tokens rotate every 15 minutes and are stored httpOnly" },
  { id: "db-pool", text: "the postgres connection pool max was raised to 40 to stop timeouts under load" },
  { id: "db-migrate", text: "ran the migration that adds a composite index on (tenant_id, created_at)" },
  { id: "db-deadlock", text: "fixed a deadlock by ordering writes to the orders and inventory tables consistently" },
  { id: "k8s-oom", text: "the inference pod kept getting OOMKilled until we raised its memory limit to 4Gi" },
  { id: "k8s-hpa", text: "horizontal pod autoscaler scales the api deployment between 3 and 12 replicas on cpu" },
  { id: "k8s-ingress", text: "ingress terminates TLS and routes /api to the backend service on port 8080" },
  { id: "fe-state", text: "moved global UI state from redux to zustand to cut boilerplate" },
  { id: "fe-bundle", text: "code-split the dashboard route to shave 300kb off the initial bundle" },
  { id: "fe-a11y", text: "added aria-labels and focus traps so the modal passes screen-reader audits" },
  { id: "ci-flaky", text: "the e2e test was flaky because it raced the dev server; added a readiness wait" },
  { id: "ci-cache", text: "cached the pnpm store in CI which cut install time from 90s to 12s" },
  { id: "ci-matrix", text: "the build matrix runs node 20 and 22 on linux and macos" },
  { id: "perf-n1", text: "killed an N+1 query by eager-loading the author relation in the feed endpoint" },
  { id: "perf-memo", text: "memoized the expensive markdown render so typing no longer janks" },
  { id: "perf-index", text: "search got 10x faster after compressing vectors with quantization" },
  { id: "sec-secrets", text: "rotated the leaked API key and moved all secrets to the vault" },
  { id: "sec-cors", text: "locked CORS to the two known origins instead of the wildcard" },
  { id: "sec-ratelimit", text: "added a token-bucket rate limiter, 100 requests per minute per ip" },
  { id: "infra-cdn", text: "put the static assets behind a CDN with a one-year immutable cache header" },
  { id: "infra-queue", text: "background jobs now go through a redis-backed queue with retries" },
  { id: "infra-logs", text: "structured logs ship to the aggregator as JSON with a trace id field" },
  { id: "api-pagination", text: "switched list endpoints from offset to cursor pagination for stable pages" },
  { id: "api-versioning", text: "the public api is versioned by URL prefix, v1 and v2 run side by side" },
  { id: "api-webhook", text: "webhooks are signed with HMAC so receivers can verify the payload" },
  { id: "test-fixtures", text: "shared test fixtures spin up an in-memory store so suites stay fast" },
  { id: "test-coverage", text: "raised coverage gate to 80 percent and added tests for the auth guard" },
  { id: "doc-readme", text: "rewrote the readme quickstart down to three commands" },
];

// Queries phrased WITHOUT the answer's keywords, to force semantic matching.
const QUERIES: Array<{ q: string; gold: string }> = [
  { q: "how did we handle login credentials", gold: "auth-iam" },
  { q: "which jwt package did we pick and why", gold: "auth-jose" },
  { q: "my containers keep dying from memory", gold: "k8s-oom" },
  { q: "the database kept locking up on writes", gold: "db-deadlock" },
  { q: "requests were timing out hitting the database", gold: "db-pool" },
  { q: "made the frontend load faster", gold: "fe-bundle" },
  { q: "tests randomly fail in the pipeline", gold: "ci-flaky" },
  { q: "the feed page was doing too many queries", gold: "perf-n1" },
  { q: "stopped a credential from leaking", gold: "sec-secrets" },
  { q: "throttle abusive callers", gold: "sec-ratelimit" },
  { q: "stable paging through long lists", gold: "api-pagination" },
  { q: "verify an incoming event is genuine", gold: "api-webhook" },
  { q: "why is vector search so quick now", gold: "perf-index" },
  { q: "keep continuous integration installs quick", gold: "ci-cache" },
];

function recallAtK(
  ranked: string[][],
  golds: string[],
  k: number,
): number {
  let hits = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i]!.slice(0, k).includes(golds[i]!)) hits++;
  }
  return hits / ranked.length;
}

// Crude lexical baseline: rank by shared lowercased word count.
function lexicalRank(query: string, k: number): string[] {
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  return CORPUS.map((d) => {
    const dWords = d.text.toLowerCase().split(/\W+/);
    let overlap = 0;
    for (const w of dWords) if (qWords.has(w)) overlap++;
    return { id: d.id, overlap };
  })
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, k)
    .map((x) => x.id);
}

async function main(): Promise<void> {
  const provider = new LocalEmbeddingProvider();
  process.stdout.write("loading embedding model (first run downloads ~23MB)… ");
  const t0 = Date.now();
  await provider.warmup();
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tEmbed = Date.now();
  const docVecs = await provider.embedBatch(CORPUS.map((d) => d.text));
  const queryVecs = await provider.embedBatch(QUERIES.map((q) => q.q));
  const embedMs = Date.now() - tEmbed;
  const dims = provider.dimensions;

  const full = new VectorIndex();
  const quant = new QuantizedVectorIndex({
    dims,
    bits: 4,
    seed: "memwarden-tq-v1",
    rescoreDepth: 100,
  });
  CORPUS.forEach((d, i) => {
    full.add(d.id, "s", docVecs[i]!);
    quant.add(d.id, "s", docVecs[i]!);
  });

  const golds = QUERIES.map((q) => q.gold);
  const fullRanked: string[][] = [];
  const quantRanked: string[][] = [];
  const lexRanked: string[][] = [];
  let searchMs = 0;
  queryVecs.forEach((qv, i) => {
    fullRanked.push(full.search(qv, 10).map((r) => r.obsId));
    const tq = Date.now();
    quantRanked.push(quant.search(qv, 10).map((r) => r.obsId));
    searchMs += Date.now() - tq;
    lexRanked.push(lexicalRank(QUERIES[i]!.q, 10));
  });

  // Compression ratio for the quant index.
  const p = quant.params;
  const fullBytes = p.dims * 4;
  const codeBytes = Math.ceil((p.paddedDims * p.bits) / 8) + 4;

  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  console.log("\n  memwarden recall benchmark — all-MiniLM-L6-v2, " + CORPUS.length + " memories, " + QUERIES.length + " paraphrased queries\n");
  console.log("  retrieval (gold answer in top-k):");
  console.log(`    full-precision   R@5 ${pct(recallAtK(fullRanked, golds, 5))}   R@10 ${pct(recallAtK(fullRanked, golds, 10))}`);
  console.log(`    TurboQuant 4-bit R@5 ${pct(recallAtK(quantRanked, golds, 5))}   R@10 ${pct(recallAtK(quantRanked, golds, 10))}`);
  console.log(`    lexical baseline R@5 ${pct(recallAtK(lexRanked, golds, 5))}   R@10 ${pct(recallAtK(lexRanked, golds, 10))}`);
  console.log("\n  compression:");
  console.log(`    ${fullBytes}B full -> ${codeBytes}B TurboQuant per vector  (${(fullBytes / codeBytes).toFixed(1)}x smaller, ${dims} dims @ 4-bit)`);
  console.log("\n  latency:");
  console.log(`    embed ${CORPUS.length + QUERIES.length} texts in ${embedMs}ms  (${Math.round((CORPUS.length + QUERIES.length) / (embedMs / 1000))}/s)`);
  console.log(`    search ${QUERIES.length} queries in ${searchMs}ms  (${(searchMs / QUERIES.length).toFixed(2)}ms each)\n`);
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
