//
// Micro-benchmark, not a gate: logs add throughput and search latency for
// the quantized index at memory-bench scale, and the memory footprint of
// codes vs full Float32 storage. The only assertion is completion within
// the vitest timeout. Ballpark on an M-series laptop: ~100k adds (dim 250
// -> padded 256, 4-bit) in single-digit seconds, single brute-force
// asymmetric query over 100k codes in low tens of ms.

import { describe, expect, it } from "vitest";
import { QuantizedVectorIndex } from "../src/functions/quantized-vector-index.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

describe("quantized index 100k bench (informational)", () => {
  it("adds 100k vectors and searches", () => {
    const DIMS = 250; // pads to 256
    const N = 100_000;
    const idx = new QuantizedVectorIndex({
      dims: DIMS,
      bits: 4,
      seed: "bench",
      rescoreDepth: 0,
    });
    const prng = mulberry32(seedFromString("bench-data"));
    const v = new Float32Array(DIMS);

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < DIMS; j++) v[j] = prng() - 0.5;
      idx.add(`obs-${i}`, "sess", v);
    }
    const addMs = performance.now() - t0;

    const q = new Float32Array(DIMS);
    for (let j = 0; j < DIMS; j++) q[j] = prng() - 0.5;
    const t1 = performance.now();
    const rows = idx.search(q, 10);
    const searchMs = performance.now() - t1;

    // Codes: 256/2 bytes + norm vs full Float32: 250*4 bytes.
    const codeBytes = 128 + 4;
    const fullBytes = DIMS * 4;
    console.log(
      `bench: add ${N} dim-${DIMS} vectors in ${addMs.toFixed(0)}ms ` +
        `(${((N / addMs) * 1000).toFixed(0)}/s); search top-10 in ${searchMs.toFixed(1)}ms; ` +
        `per-vector ${codeBytes}B vs ${fullBytes}B full (${(fullBytes / codeBytes).toFixed(1)}x smaller)`,
    );
    expect(rows.length).toBe(10);
    expect(idx.size).toBe(N);
  }, 19_000);
});
