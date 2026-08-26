//
// Summary statistics for the memory half-life study.
//
// R-7 is the default quantile estimator used by R and NumPy. For a sorted
// sample x[0..n-1], it evaluates h = (n - 1) * p and linearly interpolates
// between floor(h) and ceil(h). In particular, p=0.5 is the conventional
// sample median: the middle observation for odd n and the arithmetic mean of
// the two middle observations for even n.
//

export const QUANTILE_METHOD = "R7_LINEAR_INTERPOLATION" as const;

export function sampleQuantileR7(values: readonly number[], probability: number): number {
  if (values.length === 0) {
    throw new RangeError("sampleQuantileR7 requires at least one value");
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must be a finite number in [0, 1]");
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("sampleQuantileR7 accepts only finite sample values");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(h);
  const upperIndex = Math.ceil(h);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (h - lowerIndex);
}

export function sampleMedian(values: readonly number[]): number {
  return sampleQuantileR7(values, 0.5);
}
