import type { OcrTextBlock } from "./types";

/**
 * Adapted from Umi-OCR's MIT-licensed SingleLine and linePreprocessing
 * text-block processors. The TypeScript port keeps the same line grouping
 * rules while avoiding a Python runtime in the packaged application.
 *
 * Upstream: https://github.com/hiroi-sora/Umi-OCR
 */

interface NormalizedBlock extends OcrTextBlock {
  bbox: [number, number, number, number];
}

const ANGLE_THRESHOLD_RADIANS = (3 * Math.PI) / 180;

export function formatOcrText(blocks: OcrTextBlock[]): string {
  const normalized = normalizeBlocks(blocks);
  if (!normalized.length) return "";

  normalized.sort((left, right) => left.bbox[0] - right.bbox[0]);
  const remaining: Array<NormalizedBlock | undefined> = [...normalized];
  const lines: NormalizedBlock[][] = [];

  for (let leftIndex = 0; leftIndex < remaining.length; leftIndex += 1) {
    const first = remaining[leftIndex];
    if (!first) continue;
    let [, top, right, bottom] = first.bbox;
    let height = Math.max(1, bottom - top);
    const line = [first];

    for (let rightIndex = leftIndex + 1; rightIndex < remaining.length; rightIndex += 1) {
      const candidate = remaining[rightIndex];
      if (!candidate) continue;
      const [candidateLeft, candidateTop, candidateRight, candidateBottom] = candidate.bbox;
      const candidateHeight = Math.max(1, candidateBottom - candidateTop);
      if (candidateLeft < right - height) continue;
      if (candidateTop < top - height * 0.5 || candidateBottom > bottom + height * 0.5) continue;
      if (Math.abs(height - candidateHeight) > Math.min(height, candidateHeight) * 0.5) continue;
      line.push(candidate);
      remaining[rightIndex] = undefined;
      right = candidateRight;
      top = (top + candidateTop) / 2;
      bottom = (bottom + candidateBottom) / 2;
      height = Math.max(1, bottom - top);
    }

    lines.push(line);
    remaining[leftIndex] = undefined;
  }

  lines.sort((left, right) => left[0]!.bbox[1] - right[0]!.bbox[1]);
  return lines
    .map((line) =>
      line
        .map((block, index) => {
          const next = line[index + 1];
          if (!next) return block.text;
          const horizontalGap = next.bbox[0] - block.bbox[2];
          const averageHeight = (block.bbox[3] - block.bbox[1] + (next.bbox[3] - next.bbox[1])) / 2;
          if (horizontalGap > averageHeight * 1.5) return `${block.text} `;
          return `${block.text}${wordSeparator(block.text.at(-1) ?? "", next.text[0] ?? "")}`;
        })
        .join(""),
    )
    .join("\n")
    .trim();
}

function normalizeBlocks(blocks: OcrTextBlock[]): NormalizedBlock[] {
  const valid = blocks.filter((block) => block.text.trim() && validBox(block.box));
  if (!valid.length) return [];
  const angles = valid.map((block) => boxAngle(block.box)).sort((left, right) => left - right);
  const rotation = angles[Math.floor(angles.length / 2)] ?? 0;
  return valid.map((block) => ({ ...block, bbox: normalizeBox(block.box, rotation) }));
}

function normalizeBox(box: OcrTextBlock["box"], rotation: number): [number, number, number, number] {
  const points =
    Math.abs(rotation) <= ANGLE_THRESHOLD_RADIANS
      ? box
      : box.map(([x, y]) => {
          const cosine = Math.cos(-rotation);
          const sine = Math.sin(-rotation);
          return [cosine * x - sine * y, sine * x + cosine * y] as [number, number];
        });
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function boxAngle(box: OcrTextBlock["box"]): number {
  const width = distance(box[0], box[1]);
  const height = distance(box[1], box[2]);
  const [from, to] = width < height ? [box[1], box[2]] : [box[0], box[1]];
  let angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  if (angle < -Math.PI / 2 + ANGLE_THRESHOLD_RADIANS) angle += Math.PI;
  else if (angle >= Math.PI / 2 + ANGLE_THRESHOLD_RADIANS) angle -= Math.PI;
  return angle;
}

function distance(first: [number, number], second: [number, number]): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1]);
}

function validBox(value: OcrTextBlock["box"]): boolean {
  return value.length === 4 && value.every((point) => point.length === 2 && point.every(Number.isFinite));
}

function wordSeparator(previous: string, next: string): string {
  if (isCjk(previous) && isCjk(next)) return "";
  if (previous === "-" || isPunctuation(next)) return "";
  return " ";
}

function isCjk(value: string): boolean {
  if (!value) return false;
  const code = value.codePointAt(0) ?? -1;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function isPunctuation(value: string): boolean {
  return value ? /\p{P}/u.test(value) : false;
}
