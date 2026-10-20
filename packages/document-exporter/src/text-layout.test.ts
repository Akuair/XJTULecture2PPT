import { describe, expect, it } from "vitest";

import { formatOcrText } from "./text-layout";
import type { OcrTextBlock } from "./types";

function block(text: string, left: number, top: number, right: number, bottom: number): OcrTextBlock {
  return {
    text,
    score: 1,
    box: [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
  };
}

describe("Umi-OCR adapted text layout", () => {
  it("sorts lines from top to bottom and joins adjacent Chinese blocks", () => {
    expect(
      formatOcrText([
        block("第二行", 0, 30, 60, 50),
        block("病理", 0, 0, 40, 20),
        block("生理学", 42, 0, 100, 20),
      ]),
    ).toBe("病理生理学\n第二行");
  });

  it("returns an empty string when no text is recognized", () => {
    expect(formatOcrText([])).toBe("");
  });
});
