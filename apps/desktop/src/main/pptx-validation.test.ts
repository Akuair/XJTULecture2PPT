import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { validatePptxBuffer } from "./pptx-validation";

describe("validatePptxBuffer", () => {
  it("accepts a zip with the required PPTX structure and counts slides", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("ppt/presentation.xml", "<presentation />");
    zip.file("ppt/slides/slide1.xml", "<slide />");
    zip.file("ppt/slides/slide2.xml", "<slide />");
    const value = await zip.generateAsync({ type: "arraybuffer" });

    await expect(validatePptxBuffer(value)).resolves.toEqual({ slideCount: 2 });
  });

  it("rejects an invalid archive", async () => {
    await expect(validatePptxBuffer(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow("不是有效的 PPTX");
  });

  it("rejects a zip without slide XML", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("ppt/presentation.xml", "<presentation />");
    const value = await zip.generateAsync({ type: "arraybuffer" });

    await expect(validatePptxBuffer(value)).rejects.toThrow("没有幻灯片");
  });
});
