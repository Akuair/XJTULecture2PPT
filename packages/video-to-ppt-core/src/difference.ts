const RED_LUMINANCE = 0.2126;
const GREEN_LUMINANCE = 0.7152;
const BLUE_LUMINANCE = 0.0722;

export function calculateImageDifference(first: ImageData, second: ImageData): number {
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error("Image dimensions must match");
  }
  return calculatePixelDifference(first.data, second.data);
}

export function calculatePixelDifference(first: Uint8ClampedArray, second: Uint8ClampedArray): number {
  if (!first.length || first.length !== second.length || first.length % 4 !== 0) {
    throw new Error("RGBA pixel buffers must be non-empty and have equal lengths");
  }

  let sumOfSquares = 0;
  for (let index = 0; index < first.length; index += 4) {
    const firstLuminance =
      RED_LUMINANCE * (first[index] ?? 0) +
      GREEN_LUMINANCE * (first[index + 1] ?? 0) +
      BLUE_LUMINANCE * (first[index + 2] ?? 0);
    const secondLuminance =
      RED_LUMINANCE * (second[index] ?? 0) +
      GREEN_LUMINANCE * (second[index + 1] ?? 0) +
      BLUE_LUMINANCE * (second[index + 2] ?? 0);
    const difference = firstLuminance - secondLuminance;
    sumOfSquares += difference * difference;
  }
  return Math.sqrt(sumOfSquares / (first.length / 4));
}

export function computeDynamicThreshold(differences: number[], fallback = 30): number {
  const finite = differences.filter((value) => Number.isFinite(value) && value >= 0);
  if (!finite.length) return fallback;
  const sorted = [...finite].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? fallback;
  return Math.max(10, Math.min(median, 60));
}
