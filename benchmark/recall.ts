//
// memwarden recall benchmark. Runs the REAL on-device embedding model
// (all-MiniLM-L6-v2) over a coding-memory corpus whose queries are phrased
// with DIFFERENT words than the answers, so it measures semantic recall,
// not keyword overlap. The 30 labelled memories are buried in thousands of
// synthetic-but-plausible distractor memories, so recall is measured under
// competition — a 30-doc corpus would make every method look perfect.
//
// Reports, per configuration:
//   - full-precision vectors (the accuracy ceiling)
//   - TurboQuant 4-bit, NO rescoring — pure codes, the honest compressed
//     number (this is what "16x smaller" actually costs)
//   - TurboQuant 4-bit + top-32 exact rescore — keeps full vectors around,
//     so it trades the memory saving back for accuracy
//   - lexical baseline (does meaning-search beat keywords?)
//
// Run: npx tsx benchmark/recall.ts [--distractors N]   (default 2000)
// Honest by construction: same embeddings feed every index; ground truth is
// the labelled gold answer per query; distractors are deterministic.

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

// Deterministic distractor memories: plausible engineering notes assembled
// combinatorially. They share vocabulary and register with the gold corpus
// (that is the point — easy distractors prove nothing) but none states a
// gold answer's fact.
const D_VERBS = ["bumped", "pinned", "renamed", "refactored", "documented", "deprecated", "profiled", "instrumented", "containerized", "parallelized"];
const D_NOUNS = ["the billing worker", "the notification service", "the search indexer", "the image resizer", "the export pipeline", "the admin dashboard", "the metrics collector", "the session store", "the email templater", "the feature-flag client", "the audit logger", "the retry wrapper", "the sitemap generator", "the avatar uploader", "the changelog script", "the geo lookup", "the pdf renderer", "the cron runner", "the tag suggester", "the currency converter"];
const D_TAILS = ["after the quarterly dependency sweep", "to unblock the staging deploy", "while chasing a flaky alert", "as part of the monorepo split", "before the compliance review", "to cut cold-start time", "during the on-call handoff", "for the multi-region rollout", "when the vendor changed their SLA", "after profiling showed it was hot"];

function distractors(n: number): Doc[] {
  const docs: Doc[] = [];
  for (let i = 0; i < n; i++) {
    const v = D_VERBS[i % D_VERBS.length]!;
    const s = D_NOUNS[Math.floor(i / D_VERBS.length) % D_NOUNS.length]!;
    const t = D_TAILS[Math.floor(i / (D_VERBS.length * D_NOUNS.length)) % D_TAILS.length]!;
    docs.push({ id: `x-${i}`, text: `${v} ${s} ${t} (note ${i})` });
  }
  return docs;
}

function recallAtK(ranked: string[][], golds: string[], k: number): number {
  let hits = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i]!.slice(0, k).includes(golds[i]!)) hits++;
  }
  return hits / ranked.length;
}

// Crude lexical baseline: rank by shared lowercased word count.
function lexicalRank(docs: Doc[], query: string, k: number): string[] {
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  return docs
    .map((d) => {
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
  const flagIdx = process.argv.indexOf("--distractors");
  const nDistract =
    flagIdx >= 0 ? Math.max(0, parseInt(process.argv[flagIdx + 1] ?? "", 10) || 0) : 2000;
  const docs: Doc[] = [...CORPUS, ...distractors(nDistract)];

  const provider = new LocalEmbeddingProvider();
  process.stdout.write("loading embedding model (first run downloads ~23MB)… ");
  const t0 = Date.now();
  await provider.warmup();
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  process.stdout.write(`embedding ${docs.length} memories + ${QUERIES.length} queries… `);
  const tEmbed = Date.now();
  const docVecs: Float32Array[] = [];
  for (let i = 0; i < docs.length; i += 256) {
    docVecs.push(...(await provider.embedBatch(docs.slice(i, i + 256).map((d) => d.text))));
  }
  const queryVecs = await provider.embedBatch(QUERIES.map((q) => q.q));
  const embedMs = Date.now() - tEmbed;
  const dims = provider.dimensions;
  console.log(`${(embedMs / 1000).toFixed(1)}s`);

  const full = new VectorIndex();
  // The honest compressed configuration: codes only, nothing retained to
  // rescore against. This is the number the compression claim must survive.
  const quantPure = new QuantizedVectorIndex({
    dims,
    bits: 4,
    seed: "memwarden-tq-v1",
    rescoreDepth: 0,
  });
  // The hybrid configuration: quantized candidate scan + exact top-32
  // rescore. Full vectors stay resident, so it buys accuracy, not memory.
  const quantRescore = new QuantizedVectorIndex({
    dims,
    bits: 4,
    seed: "memwarden-tq-v1",
    rescoreDepth: 32,
  });
  docs.forEach((d, i) => {
    full.add(d.id, "s", docVecs[i]!);
    quantPure.add(d.id, "s", docVecs[i]!);
    quantRescore.add(d.id, "s", docVecs[i]!);
  });

  const golds = QUERIES.map((q) => q.gold);
  const ranked = {
    full: [] as string[][],
    pure: [] as string[][],
    rescore: [] as string[][],
    lex: [] as string[][],
  };
  let fullMs = 0;
  let pureMs = 0;
  queryVecs.forEach((qv, i) => {
    let t = Date.now();
    ranked.full.push(full.search(qv, 10).map((r) => r.obsId));
    fullMs += Date.now() - t;
    t = Date.now();
    ranked.pure.push(quantPure.search(qv, 10).map((r) => r.obsId));
    pureMs += Date.now() - t;
    ranked.rescore.push(quantRescore.search(qv, 10).map((r) => r.obsId));
    ranked.lex.push(lexicalRank(docs, QUERIES[i]!.q, 10));
  });

  // Compression ratio for the pure-code index.
  const p = quantPure.params;
  const fullBytes = p.dims * 4;
  const codeBytes = Math.ceil((p.paddedDims * p.bits) / 8) + 4;

  const pct = (x: number) => (x * 100).toFixed(1) + "%";
  const row = (name: string, r: string[][]) =>
    console.log(
      `    ${name.padEnd(30)} R@1 ${pct(recallAtK(r, golds, 1)).padStart(6)}   R@5 ${pct(recallAtK(r, golds, 5)).padStart(6)}   R@10 ${pct(recallAtK(r, golds, 10)).padStart(6)}`,
    );

  console.log(
    `\n  memwarden recall benchmark — all-MiniLM-L6-v2, ${CORPUS.length} labelled memories buried in ${nDistract} distractors (${docs.length} total), ${QUERIES.length} paraphrased queries\n`,
  );
  console.log("  retrieval (gold answer in top-k):");
  row("full-precision f32", ranked.full);
  row("TurboQuant 4-bit, no rescore", ranked.pure);
  row("TurboQuant 4-bit + rescore 32", ranked.rescore);
  row("lexical baseline", ranked.lex);
  console.log("\n  compression (no-rescore config; the rescore config keeps full vectors resident):");
  console.log(
    `    ${fullBytes}B full -> ${codeBytes}B per vector  (${(fullBytes / codeBytes).toFixed(1)}x smaller, ${dims} dims @ 4-bit)`,
  );
  console.log("\n  latency:");
  console.log(
    `    embed ${docs.length + QUERIES.length} texts in ${(embedMs / 1000).toFixed(1)}s  (${Math.round((docs.length + QUERIES.length) / (embedMs / 1000))}/s)`,
  );
  console.log(
    `    search ${docs.length} vectors: full ${(fullMs / QUERIES.length).toFixed(2)}ms/query, quantized ${(pureMs / QUERIES.length).toFixed(2)}ms/query\n`,
  );
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
