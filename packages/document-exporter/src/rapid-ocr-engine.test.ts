import { describe, expect, it } from "vitest";

import { buildRapidOcrArguments, parseOcrResponse } from "./rapid-ocr-engine";

describe("RapidOCR protocol adapter", () => {
  it("uses the Umi-OCR compatible offline engine arguments", () => {
    expect(buildRapidOcrArguments({ executablePath: "RapidOCR-json.exe" })).toContain(
      "--rec=rec_ch_PP-OCRv4_infer.onnx",
    );
    expect(buildRapidOcrArguments({ executablePath: "RapidOCR-json.exe" })).toContain("--ensureAscii=1");
  });

  it("parses the observed JSON-lines response", () => {
    expect(
      parseOcrResponse(
        JSON.stringify({
          code: 100,
          data: [
            {
              text: "课堂",
              score: 0.99,
              box: [
                [1, 2],
                [3, 2],
                [3, 4],
                [1, 4],
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      code: 100,
      data: [
        {
          text: "课堂",
          score: 0.99,
          box: [
            [1, 2],
            [3, 2],
            [3, 4],
            [1, 4],
          ],
        },
      ],
    });
    expect(parseOcrResponse("RapidOCR-json v1.1.0")).toBeUndefined();
  });
});
