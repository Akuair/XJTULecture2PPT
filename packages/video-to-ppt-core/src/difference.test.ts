import { describe, expect, it } from "vitest";

import { calculatePixelDifference, computeDynamicThreshold } from "./difference";

describe("video frame difference", () => {
  it("returns zero for identical RGBA pixels", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(calculatePixelDifference(pixels, pixels)).toBe(0);
  });

  it("uses Rec.709 luminance RMS", () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    const white = new Uint8ClampedArray([255, 255, 255, 255]);
    const red = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(calculatePixelDifference(black, white)).toBeCloseTo(255, 8);
    expect(calculatePixelDifference(black, red)).toBeCloseTo(0.2126 * 255, 8);
  });

  it("rejects mismatched or invalid pixel buffers", () => {
    expect(() => calculatePixelDifference(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow(
      /equal lengths/,
    );
    expect(() => calculatePixelDifference(new Uint8ClampedArray(), new Uint8ClampedArray())).toThrow(
      /non-empty/,
    );
  });
});

describe("dynamic threshold", () => {
  it("uses the median and clamps to the upstream 10-60 range", () => {
    expect(computeDynamicThreshold([1, 4, 20, 50, 90])).toBe(20);
    expect(computeDynamicThreshold([1, 2, 3])).toBe(10);
    expect(computeDynamicThreshold([70, 80, 90])).toBe(60);
  });

  it("returns the fallback when no finite samples exist", () => {
    expect(computeDynamicThreshold([Number.NaN, Number.POSITIVE_INFINITY], 27)).toBe(27);
  });
});
