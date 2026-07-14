# Benchmarks

## Retrieval quality

Measured on-device with the real model (`all-MiniLM-L6-v2`): 30 labelled coding memories buried
in **2,000 plausible distractor memories** (2,030 total), 14 **paraphrased** queries (worded
differently than the answers), and the compressed index running with **no exact rescoring** - pure quantized codes, nothing retained to fall back on. Reproduce with `npm run benchmark`.

| Retrieval (gold answer in top-k) | R@1 | R@5 | R@10 |
| --- | --- | --- | --- |
| Full-precision vectors | 57% | 79% | 86% |
| **TurboQuant (4-bit, no rescore)** | **57%** | **79%** | **86%** |
| Keyword search (lexical baseline) | 7% | 57% | 57% |

- **At this scale, compression costs nothing** - pure 4-bit codes match full precision on every
  metric, at 5.9× smaller vectors (384-dim @ 4-bit; ~11× at 2-bit).
- **Meaning beats keywords** - +22 points R@5, +50 points R@1, on questions that share no words
  with the answer.
- Scaling honestly: at 10,000 distractors the pure-code index gives up ~7 points of R@10 versus
  full precision; enabling top-32 exact rescoring restores exact parity but keeps full vectors
  resident (accuracy back, memory saving gone). Run
  `npx tsx benchmark/recall.ts --distractors 10000` to see it yourself.

## Vector backends

An optional native Rust backend built on [turbovec](https://github.com/RyanCodrai/turbovec)
(Google's TurboQuant algorithm; real `IdMapIndex` with stable IDs, O(1) deletion, and allowlist
filtering inside the SIMD kernel). Measured at 10,000 × 384-dim vectors
(`npm run benchmark:backends`):

| Vector backend | recall@10 vs FP32 | search p50 / p95 | bytes/vector |
| --- | --- | --- | --- |
| typescript/full (baseline) | 100% | 14.96 / 16.21 ms | 1536 |
| typescript/turboquant-4bit | 100% | 18.90 / 19.53 ms | 260 |
| **turbovec/native-4bit** | **100%** | **0.15 / 0.20 ms** | **196** |

Filtered search is scope-aware, not post-filtered: with a project/cwd filter active, the vector
stream searches inside an allowlist of in-scope ids (all three backends), which at 10,000 vectors
across 20 projects fills every top-10 slot with in-scope results at p50 1.0–1.5 ms on the
TypeScript backends versus 15–22 ms for the old global-then-postfilter scan, which left roughly
half the slots unfilled (the scope post-filter still runs on every candidate as the correctness
backstop).

~125× faster search with zero recall drop. Honest defaults: the native backend is quietly
selected when the prebuilt binary loads (pin one with `MEMWARDEN_VECTOR_BACKEND`), and
`memwarden status` always names the backend actually serving - a native backend that failed to
load reports its TypeScript fallback, never a silent claim. The binding lives in
[`native/turbovec-node/`](../native/turbovec-node/) (`@memwarden/turbovec`, MIT).

## Firewall eval

`npm run eval` runs a deterministic corpus - 250 memories across verified/sourced/unsourced
classes, 5 projects, 50 controlled staleness events, 5 poisoned-handoff traps, 5 delimiter
forgeries - and gates CI at 100% on all eight gates: stale-retrievable, stale-refusal,
fresh-retention, isolation, label accuracy, handoff-trust, verified-only policy, and injection
containment.
