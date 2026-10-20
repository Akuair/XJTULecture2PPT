import PptxGenJS from "pptxgenjs";

import type { CapturedFrame, ConversionProgressHandler } from "./types";

export async function generatePresentation(
  frames: CapturedFrame[],
  title = "XJTU Lecture2PPT",
  onProgress?: ConversionProgressHandler,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!frames.length) throw new Error("没有可用于生成 PPT 的关键帧。");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "XJTU Lecture2PPT";
  pptx.company = "XJTU Lecture2PPT";
  pptx.subject = "Lecture video key frames";
  pptx.title = title;

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: "0B1729" };
  titleSlide.addText(title, {
    x: 0.8,
    y: 2.25,
    w: 11.73,
    h: 1.2,
    fontFace: "Microsoft YaHei",
    fontSize: 28,
    bold: true,
    color: "F8FAFC",
    align: "center",
    valign: "middle",
    margin: 0,
  });
  titleSlide.addText(`由课堂视频提取 ${frames.length} 张关键帧`, {
    x: 1.2,
    y: 3.65,
    w: 10.93,
    h: 0.45,
    fontFace: "Microsoft YaHei",
    fontSize: 13,
    color: "93C5FD",
    align: "center",
    margin: 0,
  });

  for (let index = 0; index < frames.length; index += 1) {
    throwIfAborted(signal);
    const frame = frames[index];
    if (!frame) continue;
    const data = await blobToDataUrl(frame.blob, signal);
    const slide = pptx.addSlide();
    slide.background = { color: "050B14" };
    const imageBox = contain(frame.width, frame.height, 0.16, 0.16, 13.013, 7.06);
    slide.addImage({ data, ...imageBox });
    slide.addText(`${formatTime(frame.timeSeconds)}  ·  ${index + 1}/${frames.length}`, {
      x: 10.6,
      y: 7.22,
      w: 2.55,
      h: 0.2,
      fontFace: "Arial",
      fontSize: 8,
      color: "94A3B8",
      align: "right",
      margin: 0,
    });
    emit(onProgress, {
      stage: "generating-ppt",
      current: index + 1,
      total: frames.length,
      percent: ((index + 1) / frames.length) * 90,
      capturedFrames: frames.length,
      message: `正在生成第 ${index + 1}/${frames.length} 页`,
    });
  }

  throwIfAborted(signal);
  const output = await pptx.write({ outputType: "arraybuffer" });
  emit(onProgress, {
    stage: "generating-ppt",
    current: frames.length,
    total: frames.length,
    percent: 100,
    capturedFrames: frames.length,
    message: "PPTX 二进制生成完成",
  });
  return normalizeArrayBuffer(output);
}

function contain(
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const imageRatio = imageWidth / imageHeight;
  const boxRatio = width / height;
  if (imageRatio > boxRatio) {
    const fittedHeight = width / imageRatio;
    return { x, y: y + (height - fittedHeight) / 2, w: width, h: fittedHeight };
  }
  const fittedWidth = height * imageRatio;
  return { x: x + (width - fittedWidth) / 2, y, w: fittedWidth, h: height };
}

function blobToDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = (): void => reader.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("读取关键帧失败。"));
    };
    reader.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("视频转换已取消。", "AbortError"));
    };
    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      if (typeof reader.result !== "string") reject(new Error("关键帧格式无效。"));
      else resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

function normalizeArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error("PptxGenJS 没有返回 ArrayBuffer。");
}

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}

function emit(
  handler: ConversionProgressHandler | undefined,
  progress: Parameters<ConversionProgressHandler>[0],
): void {
  try {
    handler?.(progress);
  } catch {
    // UI callbacks must not interrupt generation.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("视频转换已取消。", "AbortError");
}
