import JSZip from "jszip";

import { convertPptxToPdf, validatePdf } from "./libreoffice-converter";
import { RapidOcrEngine } from "./rapid-ocr-engine";
import { formatOcrText } from "./text-layout";
import type {
  DocumentExportOptions,
  DocumentExportProgress,
  DocumentExportResult,
  OcrTextBlock,
} from "./types";

export async function exportPptxToPdfAndText(
  pptx: ArrayBuffer | Uint8Array,
  options: DocumentExportOptions,
): Promise<DocumentExportResult> {
  throwIfAborted(options.signal);
  const bytes = pptx instanceof Uint8Array ? pptx : new Uint8Array(pptx);
  emit(options, { stage: "converting-pdf", percent: 0, message: "正在使用 LibreOffice 生成 PDF" });
  const pdf = await convertPptxToPdf(bytes, {
    workingDirectory: options.workingDirectory,
    sofficeBinaryPaths: options.sofficeBinaryPaths,
    timeoutMs: options.pdfTimeoutMs,
    signal: options.signal,
  });
  emit(options, { stage: "converting-pdf", percent: 100, message: "PDF 转换完成" });

  throwIfAborted(options.signal);
  emit(options, { stage: "extracting-images", percent: 0, message: "正在读取幻灯片关键帧" });
  const images = await extractSlideImages(bytes);
  if (!images.length) throw new Error("PPTX 中没有可供 OCR 的关键帧图片。");
  emit(options, {
    stage: "extracting-images",
    current: images.length,
    total: images.length,
    percent: 100,
    message: `已读取 ${images.length} 张关键帧`,
  });

  const engine = new RapidOcrEngine({
    executablePath: options.rapidOcrExecutablePath,
    initializationTimeoutMs: options.ocrInitializationTimeoutMs,
    pageTimeoutMs: options.ocrPageTimeoutMs,
  });
  const pages: string[] = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      throwIfAborted(options.signal);
      emit(options, {
        stage: "recognizing-text",
        current: index,
        total: images.length,
        percent: (index / images.length) * 100,
        message: `正在识别第 ${index + 1}/${images.length} 张关键帧`,
      });
      const response = await engine.recognize(images[index]!, options.signal);
      if (response.code === 100) pages.push(formatOcrText(response.data as OcrTextBlock[]));
      else if (response.code === 101) pages.push("");
      else throw new Error(`RapidOCR 识别失败（code=${response.code}）：${String(response.data)}`);
    }
  } finally {
    engine.stop();
  }
  emit(options, {
    stage: "recognizing-text",
    current: images.length,
    total: images.length,
    percent: 100,
    message: `已识别 ${images.length} 张关键帧`,
  });

  emit(options, { stage: "writing-text", percent: 0, message: "正在整理 TXT" });
  const text = buildTextDocument(options.title, pages);
  validateText(text);
  emit(options, { stage: "writing-text", percent: 100, message: "TXT 内容生成完成" });

  emit(options, { stage: "validating", percent: 0, message: "正在验证 PDF 和 TXT" });
  validatePdf(pdf);
  validateText(text);
  emit(options, { stage: "validating", percent: 100, message: "PDF 和 TXT 验证通过" });
  return { pdf, text, recognizedImageCount: images.length };
}

export async function extractSlideImages(pptx: Uint8Array): Promise<Uint8Array[]> {
  const archive = await JSZip.loadAsync(pptx);
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir && /^ppt\/media\/image[^/]*\.(?:jpe?g|png)$/i.test(entry.name))
    .sort((left, right) => compareImageNames(left.name, right.name));
  const result: Uint8Array[] = [];
  for (const entry of entries) result.push(await entry.async("uint8array"));
  return result;
}

export function buildTextDocument(title: string, pages: string[]): string {
  const sections = pages.map((page, index) => `第 ${index + 2} 页\n${page || "（未识别到文字）"}`);
  return [`${title}\n`, ...sections].join("\n\n").trimEnd() + "\n";
}

export function validateText(text: string): void {
  if (!text.trim()) throw new Error("OCR 没有生成可写入的 TXT 内容。");
  if (text.includes("\0")) throw new Error("OCR 文本包含无效字符。");
}

function compareImageNames(left: string, right: string): number {
  const leftNumbers = [...left.matchAll(/\d+/g)].map((match) => Number(match[0]));
  const rightNumbers = [...right.matchAll(/\d+/g)].map((match) => Number(match[0]));
  for (let index = 0; index < Math.max(leftNumbers.length, rightNumbers.length); index += 1) {
    const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

function emit(options: DocumentExportOptions, progress: DocumentExportProgress): void {
  try {
    options.onProgress?.(progress);
  } catch {
    // Progress listeners must not interrupt document generation.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("文档导出已取消。");
  error.name = "AbortError";
  throw error;
}
