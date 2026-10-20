import JSZip from "jszip";

export interface PptxValidationResult {
  slideCount: number;
}

export async function validatePptxBuffer(value: ArrayBuffer): Promise<PptxValidationResult> {
  if (value.byteLength <= 0) throw new Error("生成的 PPTX 文件为空。");
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(value);
  } catch {
    throw new Error("生成结果不是有效的 PPTX 压缩包。");
  }
  if (!archive.file("[Content_Types].xml") || !archive.file("ppt/presentation.xml")) {
    throw new Error("生成结果缺少 PPTX 必需结构。");
  }
  const slideCount = Object.keys(archive.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
  if (!slideCount) throw new Error("生成的 PPTX 没有幻灯片。");
  return { slideCount };
}
