//
// Vector backend comparison + promotion gate. Deterministic and synthetic
// (no model download): 10K gaussian unit vectors at 384 dims (MiniLM
// geometry), 100 noisy queries. Ground truth is the full-precision
// VectorIndex. Compares:
//
//   typescript/full              — exact cosine (the reference)
//   typescript/turboquant-4bit   — portable TS index, rescore 0 (max compression)
//   turbovec/native-4bit         — @memwarden/turbovec, when built
//
// Reports 1-recall@10 (FP32's true top-1 found in the backend's top-10) and
// overlap recall@10 (|top10 ∩ FP32 top10|/10), p50/p95 search latency, add
// throughput, per-vector memory, then runs the PROMOTION GATE. The gate is
// what makes the "auto" default honest: @memwarden/turbovec binaries are
// published only after this gate passes in CI on their platform, so a
// binary that loads is a binary that earned it (see config.ts
// getVectorBackend and .github/workflows/turbovec-release.yml).
//
//   GATE 1  recall: 1-recall@10 drop vs FP32 <= 2 points
//   GATE 2  allowlist: filtered search returns ONLY allowed ids
//   GATE 3  lifecycle: identical searchable id set after add/remove/save/load
//
// Run: npx tsx benchmark/backends.ts

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { VectorIndex } from "../src/functions/vector-index.js";
import { QuantizedVectorIndex } from "../src/functions/quantized-vector-index.js";
import {
  TurbovecBackend,
  type NativeTurbovecModule,
} from "../src/functions/turbovec-backend.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";
import type { VectorBackend } from "../src/functions/vector-backend.js";

const DIMS = 384;
const N = 10_000;
const N_QUERIES = 100;
const K = 10;
const REMOVED = 500;
const RECALL_DROP_GATE_POINTS = 2;

// serialize() of the turbovec backend writes its .tvim under the data dir;
// keep the benchmark self-contained.
const scratch = mkdtempSync(join(tmpdir(), "memwarden-bench-"));
process.env.MEMWARDEN_DATA_DIR = scratch;

// --- deterministic data ------------------------------------------------

function gaussianUnitVectors(count: number, seed: string): Float32Array[] {
  const rand = mulberry32(seedFromString(seed));
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(DIMS);
    let norm = 0;
    for (let d = 0; d < DIMS; d++) {
      const x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      v[d] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIMS; d++) v[d] = (v[d] as number) / norm;
    out.push(v);
  }
  return out;
}

/** Queries = dataset vectors + gaussian noise, renormalized (realistic
 * "paraphrase" geometry: near, not identical). */
function noisyQueries(base: Float32Array[], count: number, seed: string): Float32Array[] {
  const rand = mulberry32(seedFromString(seed));
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const src = base[Math.floor(rand() * base.length)]!;
    const q = new Float32Array(DIMS);
    let norm = 0;
    for (let d = 0; d < DIMS; d++) {
      const noise =
        0.35 * Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand()) / Math.sqrt(DIMS);
      const x = (src[d] as number) + noise;
      q[d] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIMS; d++) q[d] = (q[d] as number) / norm;
    out.push(q);
  }
  return out;
}

// --- helpers ----------------------------------------------------------

function percentile(sortedMs: number[], p: number): number {
  const i = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, i)] as number;
}

interface BackendReport {
  label: string;
  addPerSec: number;
  p50: number;
  p95: number;
  bytesPerVector: number;
  oneRecallAt10: number; // FP32 top-1 present in backend top-10
  overlapRecallAt10: number; // |top10 ∩ FP32 top10| / 10
  ranked: string[][];
}

function measure(
  backend: VectorBackend,
  vectors: Float32Array[],
  queries: Float32Array[],
  truthTop1: string[],
  truthTop10: string[][],
  bytesPerVector: number,
): BackendReport {
  const t0 = performance.now();
  for (let i = 0; i < vectors.length; i++) backend.add(`obs-${i}`, "s", vectors[i]!);
  const addMs = performance.now() - t0;

  const times: number[] = [];
  const ranked: string[][] = [];
  for (const q of queries) {
    const tq = performance.now();
    const hits = backend.search(q, K);
    times.push(performance.now() - tq);
    ranked.push(hits.map((h) => h.obsId));
  }
  times.sort((a, b) => a - b);

  let top1Hits = 0;
  let overlap = 0;
  for (let i = 0; i < queries.length; i++) {
    if (ranked[i]!.includes(truthTop1[i]!)) top1Hits++;
    const truth = new Set(truthTop10[i]!);
    overlap += ranked[i]!.filter((id) => truth.has(id)).length / K;
  }

  return {
    label: backend.backendLabel,
    addPerSec: Math.round(vectors.length / (addMs / 1000)),
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    bytesPerVector,
    oneRecallAt10: (top1Hits / queries.length) * 100,
    overlapRecallAt10: (overlap / queries.length) * 100,
    ranked,
  };
}

// --- filtered search: allowlist path vs global-then-postfilter ----------
//
// The production shape: 10K vectors spread across N_PROJECTS synthetic
// projects, a query scoped to ONE project (~N/N_PROJECTS in scope). The old
// path over-fetches a global top-k and post-filters it; the new path (wired
// in mem::search) hands the backend the in-scope allowlist and fills k from
// within it. Correctness bar for both: ZERO out-of-scope results.

const N_PROJECTS = 20;

interface FilteredReport {
  label: string;
  oldP50: number;
  oldP95: number;
  newP50: number;
  newP95: number;
  oldOutOfScope: number;
  newOutOfScope: number;
  oldHits: number;
  newHits: number;
}

function measureFiltered(
  backend: VectorBackend,
  queries: Float32Array[],
): FilteredReport | null {
  if (typeof backend.searchAllowed !== "function") return null;
  // Project assignment is by id: obs-i belongs to project i % N_PROJECTS.
  const project = 7; // arbitrary fixed target project
  const inScope = (id: string): boolean =>
    parseInt(id.slice(4), 10) % N_PROJECTS === project;
  const allowed = new Set<string>();
  for (const id of backend.ids()) if (inScope(id)) allowed.add(id);

  // Old path: global over-fetch (the mem::search filtering factor, k*10)
  // then post-filter down to k.
  const oldTimes: number[] = [];
  let oldOutOfScope = 0;
  let oldHits = 0;
  for (const q of queries) {
    const t = performance.now();
    const hits = backend
      .search(q, K * 10)
      .filter((h) => inScope(h.obsId))
      .slice(0, K);
    oldTimes.push(performance.now() - t);
    oldHits += hits.length;
    for (const h of hits) if (!inScope(h.obsId)) oldOutOfScope++;
  }

  // New path: allowlist search fills k from within the scope.
  const newTimes: number[] = [];
  let newOutOfScope = 0;
  let newHits = 0;
  for (const q of queries) {
    const t = performance.now();
    const hits = backend.searchAllowed(q, K, allowed);
    newTimes.push(performance.now() - t);
    newHits += hits.length;
    for (const h of hits) if (!allowed.has(h.obsId)) newOutOfScope++;
  }

  oldTimes.sort((a, b) => a - b);
  newTimes.sort((a, b) => a - b);
  return {
    label: backend.backendLabel,
    oldP50: percentile(oldTimes, 50),
    oldP95: percentile(oldTimes, 95),
    newP50: percentile(newTimes, 50),
    newP95: percentile(newTimes, 95),
    oldOutOfScope,
    newOutOfScope,
    oldHits,
    newHits,
  };
}

/** Same searchable id set after remove + serialize/restore round trip. */
function lifecycleCheck(
  make: () => VectorBackend,
  restore: (blob: string) => VectorBackend | null,
  vectors: Float32Array[],
  queries: Float32Array[],
): { ok: boolean; detail: string } {
  const b = make();
  for (let i = 0; i < vectors.length; i++) b.add(`obs-${i}`, "s", vectors[i]!);
  const removed = new Set<string>();
  const rand = mulberry32(seedFromString("lifecycle"));
  while (removed.size < REMOVED) {
    const id = `obs-${Math.floor(rand() * vectors.length)}`;
    if (!removed.has(id)) {
      removed.add(id);
      b.remove(id);
    }
  }
  const expected = new Set(b.ids());
  const blob = b.serialize();
  const r = restore(blob);
  if (!r) return { ok: false, detail: "restore returned null/false" };
  const got = new Set(r.ids());
  if (got.size !== expected.size) {
    return { ok: false, detail: `id set size ${got.size} != ${expected.size} after save/load` };
  }
  for (const id of expected) {
    if (!got.has(id)) return { ok: false, detail: `id ${id} lost in save/load` };
  }
  // removed ids must never surface in post-restore searches
  for (const q of queries.slice(0, 20)) {
    for (const hit of r.search(q, 50)) {
      if (removed.has(hit.obsId)) {
        return { ok: false, detail: `removed id ${hit.obsId} returned by search after restore` };
      }
    }
  }
  return { ok: true, detail: `${expected.size} ids intact, ${REMOVED} removals honored` };
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nmemwarden vector-backend benchmark — ${N} x ${DIMS}d deterministic vectors, ${N_QUERIES} queries, k=${K}\n`);

  const vectors = gaussianUnitVectors(N, "memwarden-bench-v1");
  const queries = noisyQueries(vectors, N_QUERIES, "memwarden-bench-queries");

  // Ground truth: exact cosine over full-precision vectors.
  const full = new VectorIndex();
  const fullReport = measure(
    full,
    vectors,
    queries,
    [],
    [],
    DIMS * 4,
  );
  const truthTop10 = fullReport.ranked;
  const truthTop1 = truthTop10.map((r) => r[0]!);
  // FP32 is its own truth.
  fullReport.oneRecallAt10 = 100;
  fullReport.overlapRecallAt10 = 100;

  const makeQuant = () =>
    new QuantizedVectorIndex({ dims: DIMS, bits: 4, seed: "memwarden-tq-v1", rescoreDepth: 0 });
  const quant = makeQuant();
  // TS quant bytes/vector: packed codes over padded dims + norm.
  const quantBytes = Math.ceil((quant.params.paddedDims * quant.params.bits) / 8) + 4;
  const quantReport = measure(quant, vectors, queries, truthTop1, truthTop10, quantBytes);

  // Native turbovec, when the binary is built.
  const require = createRequire(import.meta.url);
  let native: NativeTurbovecModule | null = null;
  try {
    const mod = require(
      join(dirname(fileURLToPath(import.meta.url)), "..", "native", "turbovec-node", "index.js"),
    ) as NativeTurbovecModule;
    new mod.TurbovecIndex(8, 4);
    native = mod;
  } catch {
    native = null;
  }

  let turboReport: BackendReport | null = null;
  let allowlistGate: { ok: boolean; detail: string } | null = null;
  let turboLifecycle: { ok: boolean; detail: string } | null = null;
  let turboBackend: TurbovecBackend | null = null;
  if (native) {
    const turbo = new TurbovecBackend(native, DIMS, 4);
    turboBackend = turbo;
    // turbovec bytes/vector: 4-bit codes over true dims + f32 scale.
    const turboBytes = Math.ceil((DIMS * 4) / 8) + 4;
    turboReport = measure(turbo, vectors, queries, truthTop1, truthTop10, turboBytes);

    // GATE 2 — allowlist: only allowed ids, ever.
    const rand = mulberry32(seedFromString("bench-allowlist"));
    let violations = 0;
    let trials = 0;
    for (let t = 0; t < 20; t++) {
      const allowed = new Set<string>();
      for (let i = 0; i < N; i++) if (rand() < 0.05) allowed.add(`obs-${i}`);
      const q = queries[t % queries.length]!;
      for (const hit of turbo.searchAllowed(q, K, [...allowed])) {
        trials++;
        if (!allowed.has(hit.obsId)) violations++;
      }
    }
    allowlistGate = {
      ok: violations === 0 && trials > 0,
      detail: `${trials} filtered hits checked, ${violations} violations`,
    };

    // GATE 3 (native) — add/remove/save/load id-set parity.
    turboLifecycle = lifecycleCheck(
      () => new TurbovecBackend(native!, DIMS, 4),
      (blob) => {
        const r = new TurbovecBackend(native!, DIMS, 4);
        return r.restoreFromBlob(blob) ? r : null;
      },
      vectors,
      queries,
    );
  }

  // GATE 3 (TS quant) — same lifecycle contract for the portable fallback.
  const quantLifecycle = lifecycleCheck(
    makeQuant,
    (blob) => QuantizedVectorIndex.deserialize(blob),
    vectors,
    queries,
  );

  // --- report ---------------------------------------------------------

  const fmt = (r: BackendReport): string =>
    `  ${r.label.padEnd(28)} 1-recall@10 ${r.oneRecallAt10.toFixed(1).padStart(5)}%   ` +
    `overlap@10 ${r.overlapRecallAt10.toFixed(1).padStart(5)}%   ` +
    `p50 ${r.p50.toFixed(2)}ms  p95 ${r.p95.toFixed(2)}ms   ` +
    `add ${String(r.addPerSec).padStart(7)}/s   ${r.bytesPerVector}B/vec (~${((r.bytesPerVector * N) / 1024 / 1024).toFixed(1)}MB @ ${N})`;

  console.log(fmt(fullReport));
  console.log(fmt(quantReport));
  if (turboReport) console.log(fmt(turboReport));
  else {
    console.log(
      "  turbovec/native-4bit         UNAVAILABLE — .node binary not built " +
        "(cd native/turbovec-node && npm install && npm run build)",
    );
  }

  // --- filtered search --------------------------------------------------

  console.log(
    `\n  filtered search — ${N} vectors across ${N_PROJECTS} projects, query scoped to one ` +
      `(~${Math.round(N / N_PROJECTS)} in scope), k=${K}:`,
  );
  const filteredReports: FilteredReport[] = [];
  // These instances already hold the 10K vectors from measure() above.
  const filteredBackends: VectorBackend[] = [full, quant];
  if (turboBackend) filteredBackends.push(turboBackend);
  for (const backend of filteredBackends) {
    const r = measureFiltered(backend, queries);
    if (r) filteredReports.push(r);
  }
  for (const r of filteredReports) {
    console.log(
      `  ${r.label.padEnd(28)} old global+postfilter p50 ${r.oldP50.toFixed(2)}ms p95 ${r.oldP95.toFixed(2)}ms ` +
        `(${r.oldHits}/${N_QUERIES * K} hits filled)   ` +
        `new allowlist p50 ${r.newP50.toFixed(2)}ms p95 ${r.newP95.toFixed(2)}ms ` +
        `(${r.newHits}/${N_QUERIES * K} hits filled)   ` +
        `out-of-scope old/new: ${r.oldOutOfScope}/${r.newOutOfScope}`,
    );
  }
  const filteredCorrect = filteredReports.every(
    (r) => r.oldOutOfScope === 0 && r.newOutOfScope === 0,
  );

  // --- gates ------------------------------------------------------------

  console.log("\n  promotion gate (native default eligibility):");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  if (turboReport) {
    const drop = 100 - turboReport.oneRecallAt10;
    checks.push({
      name: `GATE 1 recall drop <= ${RECALL_DROP_GATE_POINTS} points vs FP32`,
      ok: drop <= RECALL_DROP_GATE_POINTS,
      detail: `turbovec 1-recall@10 ${turboReport.oneRecallAt10.toFixed(1)}% (drop ${drop.toFixed(1)} points)`,
    });
    checks.push({ name: "GATE 2 allowlist returns only allowed ids", ...allowlistGate! });
    checks.push({ name: "GATE 3 native add/remove/save/load id-set parity", ...turboLifecycle! });
  } else {
    checks.push({
      name: "GATE native binary present",
      ok: false,
      detail: "native backend unavailable on this machine",
    });
  }
  checks.push({ name: "GATE 3 (fallback) TS quant add/remove/save/load id-set parity", ...quantLifecycle });
  checks.push({
    name: "GATE 4 filtered search: zero out-of-scope results (old + new path, every backend)",
    ok: filteredCorrect && filteredReports.length > 0,
    detail: `${filteredReports.length} backends checked, ` +
      `${filteredReports.reduce((s, r) => s + r.oldOutOfScope + r.newOutOfScope, 0)} violations`,
  });

  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`    ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  }

  console.log(
    allOk
      ? "\n  RESULT: PASS — turbovec meets the promotion gate on this machine. Auto" +
          "\n  mode selects it whenever the binary loads; pin explicitly with" +
          "\n  MEMWARDEN_VECTOR_BACKEND=turbovec|typescript.\n"
      : "\n  RESULT: FAIL — this binary must NOT ship; auto mode falls back to the" +
          "\n  TypeScript backend on machines where the binding does not load.\n",
  );
  rmSync(scratch, { recursive: true, force: true });
  if (!allOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
