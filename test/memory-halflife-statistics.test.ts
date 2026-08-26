import { describe, expect, it } from "vitest";
import {
  QUANTILE_METHOD,
  sampleMedian,
  sampleQuantileR7,
} from "../eval/memory-halflife-statistics.js";

describe("memory half-life summary statistics", () => {
  it("uses the middle observation as the median for an odd sample", () => {
    expect(sampleMedian([9, 1, 5])).toBe(5);
  });

  it("averages the two middle observations as the median for an even sample", () => {
    expect(sampleMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it("implements R-7 linear interpolation for quartiles", () => {
    expect(QUANTILE_METHOD).toBe("R7_LINEAR_INTERPOLATION");
    expect(sampleQuantileR7([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(sampleQuantileR7([1, 2, 3, 4], 0.75)).toBe(3.25);
  });

  it("handles endpoints and does not mutate the caller's sample", () => {
    const values = [3, 1, 2];
    expect(sampleQuantileR7(values, 0)).toBe(1);
    expect(sampleQuantileR7(values, 1)).toBe(3);
    expect(values).toEqual([3, 1, 2]);
  });

  it("rejects empty, non-finite, and out-of-range inputs", () => {
    expect(() => sampleMedian([])).toThrow(/at least one/);
    expect(() => sampleMedian([1, Number.NaN])).toThrow(/finite sample/);
    expect(() => sampleQuantileR7([1], -0.01)).toThrow(/\[0, 1\]/);
    expect(() => sampleQuantileR7([1], 1.01)).toThrow(/\[0, 1\]/);
  });
});
