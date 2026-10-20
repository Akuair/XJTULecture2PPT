import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";

import { exportPptxToPdfAndText, extractSlideImages } from "./document-exporter";

const enabled = process.env.RUN_DOCUMENT_EXPORT_SMOKE === "1";
const workingDirectory = join(tmpdir(), `xjtu-document-export-smoke-${crypto.randomUUID()}`);

(enabled ? describe : describe.skip)("document exporter real engines", () => {
  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("converts a real image-only PPTX to PDF and OCR text", async () => {
    const imagePath = requiredEnvironment("DOCUMENT_EXPORT_SMOKE_IMAGE");
    const image = await readFile(imagePath);
    const presentation = new PptxGenJS();
    presentation.layout = "LAYOUT_WIDE";
    const slide = presentation.addSlide();
    slide.addImage({
      data: `data:image/png;base64,${image.toString("base64")}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
    const pptx = await presentation.write({ outputType: "arraybuffer" });
    const archive = await JSZip.loadAsync(normalizeArrayBuffer(pptx));
    const mediaNames = Object.keys(archive.files).filter((name) => name.startsWith("ppt/media/"));
    expect(mediaNames.length, `PptxGenJS media entries: ${mediaNames.join(", ")}`).toBeGreaterThan(0);
    expect(
      (await extractSlideImages(new Uint8Array(normalizeArrayBuffer(pptx)))).length,
      `PptxGenJS media entries: ${mediaNames.join(", ")}`,
    ).toBe(1);

    const result = await exportPptxToPdfAndText(normalizeArrayBuffer(pptx), {
      title: "OCR smoke test",
      workingDirectory,
      rapidOcrExecutablePath: requiredEnvironment("RAPID_OCR_EXE"),
      sofficeBinaryPaths: [requiredEnvironment("SOFFICE_EXE")],
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.text).toContain("XJTU Lecture2PPT");
    expect(result.recognizedImageCount).toBe(1);
  }, 120_000);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the document-export smoke test.`);
  return value;
}

function normalizeArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error("PptxGenJS did not return an ArrayBuffer.");
}
