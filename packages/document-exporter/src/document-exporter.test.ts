import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildTextDocument, extractSlideImages, validateText } from "./document-exporter";

describe("document exporter", () => {
  it("extracts PPT media images in numeric order", async () => {
    const archive = new JSZip();
    archive.file("ppt/media/image10.jpeg", new Uint8Array([10]));
    archive.file("ppt/media/image2.png", new Uint8Array([2]));
    archive.file("ppt/media/image-3-1.png", new Uint8Array([3]));
    archive.file("ppt/slides/slide1.xml", "<slide />");
    const pptx = await archive.generateAsync({ type: "uint8array" });

    const images = await extractSlideImages(pptx);
    expect(images.map((image) => image[0])).toEqual([2, 3, 10]);
  });

  it("writes a readable page-separated TXT document", () => {
    expect(buildTextDocument("病理生理学", ["第一张内容", ""])).toBe(
      "病理生理学\n\n\n第 2 页\n第一张内容\n\n第 3 页\n（未识别到文字）\n",
    );
  });

  it("rejects empty and nul-containing TXT output", () => {
    expect(() => validateText("   ")).toThrow();
    expect(() => validateText("课堂\0内容")).toThrow();
  });
});
