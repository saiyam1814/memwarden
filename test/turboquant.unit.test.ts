//
// Unit tests for the TurboQuant math core: transform correctness,
// determinism, Lloyd-Max optimality against literature values, packing
// round-trips, and distortion bounds against the analytic Gaussian
// quantizer constants.

import { describe, expect, it } from "vitest";
import {
  ROTATION_ROUNDS,
  nextPow2,
  seedFromString,
  mulberry32,
  buildSignFlips,
  fwht,
  rotate,
  lloydMaxLevels,
  levelTableHash,
  packCodes,
  unpackCodes,
  encodeRotated,
  asymmetricDot,
} from "../src/functions/turboquant.js";

// Seeded standard-normal sampler (Box-Muller over mulberry32) so the
// statistical assertions are reproducible.
function gaussianSampler(seed: string): () => number {
  const prng = mulberry32(seedFromString(seed));
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = prng();
    v = prng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

describe("nextPow2", () => {
  it("handles boundaries", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(384)).toBe(512);
    expect(nextPow2(768)).toBe(1024);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1536)).toBe(2048);
  });
});

describe("fwht / rotate", () => {
  it("fwht applied twice is n * identity", () => {
    const n = 16;
    const original = Float32Array.from({ length: n }, (_, i) => i - 7.5);
    const buf = Float32Array.from(original);
    fwht(buf);
    fwht(buf);
    for (let i = 0; i < n; i++) {
      expect(buf[i]).toBeCloseTo((original[i] as number) * n, 3);
    }
  });

  it("rotate preserves the norm within 1e-4 relative", () => {
    const d = 300; // pads to 512
    const D = nextPow2(d);
    const gauss = gaussianSampler("norm-test");
    const src = Float32Array.from({ length: d }, () => gauss());
    let normIn = 0;
    for (let i = 0; i < d; i++) normIn += (src[i] as number) ** 2;
    const flips = buildSignFlips(
      mulberry32(seedFromString("s")),
      D,
      ROTATION_ROUNDS,
    );
    const out = rotate(src, D, flips);
    let normOut = 0;
    for (let i = 0; i < D; i++) normOut += (out[i] as number) ** 2;
    expect(Math.abs(Math.sqrt(normOut) - Math.sqrt(normIn))).toBeLessThan(
      1e-4 * Math.sqrt(normIn),
    );
  });

  it("sanitizes NaN/Inf inputs to finite output", () => {
    const d = 8;
    const src = Float32Array.from([1, NaN, Infinity, -Infinity, 2, 0, 3, 4]);
    const flips = buildSignFlips(mulberry32(1), 8, ROTATION_ROUNDS);
    const out = rotate(src, 8, flips);
    for (let i = 0; i < 8; i++) {
      expect(Number.isFinite(out[i] as number)).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("same seed produces identical sign flips, different seed differs", () => {
    const a = buildSignFlips(mulberry32(seedFromString("x")), 64, 3);
    const b = buildSignFlips(mulberry32(seedFromString("x")), 64, 3);
    const c = buildSignFlips(mulberry32(seedFromString("y")), 64, 3);
    expect(a.map((r) => Array.from(r))).toEqual(b.map((r) => Array.from(r)));
    expect(a.map((r) => Array.from(r))).not.toEqual(
      c.map((r) => Array.from(r)),
    );
  });

  it("pins the PRNG stream (cross-process determinism proxy)", () => {
    const prng = mulberry32(seedFromString("memwarden-tq-v1"));
    const first = [prng(), prng(), prng()];
    const again = mulberry32(seedFromString("memwarden-tq-v1"));
    expect([again(), again(), again()]).toEqual(first);
  });
});

describe("lloydMaxLevels", () => {
  it("2-bit matches the literature N(0,1) optimal quantizer", () => {
    const { levels } = lloydMaxLevels(2);
    // Max-Lloyd 4-level standard normal: ±0.4528, ±1.510 (Max, 1960).
    expect(levels[0]).toBeCloseTo(-1.51, 2);
    expect(levels[1]).toBeCloseTo(-0.4528, 2);
    expect(levels[2]).toBeCloseTo(0.4528, 2);
    expect(levels[3]).toBeCloseTo(1.51, 2);
  });

  it("4-bit levels are ascending and symmetric", () => {
    const { levels, boundaries } = lloydMaxLevels(4);
    expect(levels.length).toBe(16);
    expect(boundaries.length).toBe(15);
    for (let i = 1; i < 16; i++) {
      expect(levels[i] as number).toBeGreaterThan(levels[i - 1] as number);
    }
    for (let i = 0; i < 16; i++) {
      expect(levels[i] as number).toBeCloseTo(-(levels[15 - i] as number), 4);
    }
  });

  it("level table hash is stable", () => {
    expect(levelTableHash(4)).toBe(levelTableHash(4));
    expect(levelTableHash(2)).not.toBe(levelTableHash(4));
  });
});

describe("packCodes / unpackCodes", () => {
  it("round-trips 4-bit codes including odd lengths", () => {
    const codes = Uint8Array.from({ length: 13 }, (_, i) => i % 16);
    expect(Array.from(unpackCodes(packCodes(codes, 4), 13, 4))).toEqual(
      Array.from(codes),
    );
  });

  it("round-trips 2-bit codes including non-multiple-of-4 lengths", () => {
    const codes = Uint8Array.from({ length: 11 }, (_, i) => i % 4);
    expect(Array.from(unpackCodes(packCodes(codes, 2), 11, 2))).toEqual(
      Array.from(codes),
    );
  });
});

describe("quantization distortion", () => {
  // Empirical per-coordinate MSE of the Lloyd-Max quantizer on N(0,1)
  // samples must stay within 1.15x of the analytic optimum:
  // 4 levels -> 0.1175, 16 levels -> 0.009497 (Max 1960 / Lloyd 1982).
  it("meets the analytic bound at 2 and 4 bits", () => {
    const gauss = gaussianSampler("distortion");
    for (const [bits, bound] of [
      [2, 0.1175],
      [4, 0.009497],
    ] as const) {
      const { levels, boundaries } = lloydMaxLevels(bits);
      let se = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) {
        const z = gauss();
        let lo = 0;
        let hi = boundaries.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((boundaries[mid] as number) < z) lo = mid + 1;
          else hi = mid;
        }
        const err = z - (levels[lo] as number);
        se += err * err;
      }
      expect(se / N).toBeLessThan(bound * 1.15);
    }
  });
});

describe("encodeRotated / asymmetricDot", () => {
  it("estimates cosine for identical vectors near 1", () => {
    const d = 256;
    const D = nextPow2(d);
    const gauss = gaussianSampler("encdot");
    const v = Float32Array.from({ length: d }, () => gauss());
    const flips = buildSignFlips(
      mulberry32(seedFromString("s2")),
      D,
      ROTATION_ROUNDS,
    );
    const rotated = rotate(v, D, flips);
    const { codes, norm } = encodeRotated(new Float32Array(rotated), D, 4);
    expect(norm).toBeGreaterThan(0);
    const rotatedQuery = rotate(v, D, flips);
    let qNorm = 0;
    for (let i = 0; i < D; i++) qNorm += (rotatedQuery[i] as number) ** 2;
    qNorm = Math.sqrt(qNorm);
    const est = asymmetricDot(rotatedQuery, codes, D, 4) / (Math.sqrt(D) * qNorm);
    expect(est).toBeGreaterThan(0.95);
    expect(est).toBeLessThan(1.05);
  });

  it("zero vector encodes with norm 0 and finite codes", () => {
    const D = 64;
    const { codes, norm } = encodeRotated(new Float32Array(D), D, 4);
    expect(norm).toBe(0);
    expect(codes.length).toBe(32);
  });
});
