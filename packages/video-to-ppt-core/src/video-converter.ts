import { calculateImageDifference, computeDynamicThreshold } from "./difference";
import { generatePresentation } from "./ppt-generation";
import type {
  CapturedFrame,
  ConversionOptions,
  ConversionProgress,
  ConversionProgressHandler,
  ConversionResult,
} from "./types";

const DEFAULT_CAPTURE_INTERVAL_SECONDS = 3;
const DEFAULT_MAX_SLIDES = 256;
const DEFAULT_JPEG_QUALITY = 0.82;
const DEFAULT_ANALYSIS_WIDTH = 480;
const DEFAULT_SEEK_TIMEOUT_MS = 15_000;

export async function convertVideoUrlToPpt(
  mediaUrl: string,
  options: ConversionOptions = {},
  onProgress?: ConversionProgressHandler,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  throwIfAborted(signal);
  emit(onProgress, { stage: "loading", percent: 0, message: "正在加载本地视频" });
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.style.display = "none";
  document.body.append(video);

  try {
    await loadVideo(video, mediaUrl, options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS, signal);
    const durationSeconds = video.duration;
    const analyzedEndTimeSeconds = normalizedEndTime(durationSeconds, options.endTimeSeconds);
    const analysisCanvas = document.createElement("canvas");
    const captureCanvas = document.createElement("canvas");
    const threshold =
      options.threshold ?? (await preprocessVideo(video, analysisCanvas, options, onProgress, signal));
    const frames = await extractKeyFrames(
      video,
      analysisCanvas,
      captureCanvas,
      threshold,
      options,
      onProgress,
      signal,
    );
    if (!frames.length) throw new Error("视频中没有提取到可生成幻灯片的画面。");
    const pptx = await generatePresentation(frames, options.title, onProgress, signal);
    return {
      pptx,
      durationSeconds,
      analyzedEndTimeSeconds,
      threshold,
      capturedFrameCount: frames.length,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

export async function preprocessVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options: ConversionOptions = {},
  onProgress?: ConversionProgressHandler,
  signal?: AbortSignal,
): Promise<number> {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建视频分析画布。");
  resizeAnalysisCanvas(canvas, video, options.analysisWidth ?? DEFAULT_ANALYSIS_WIDTH);
  const start = normalizedStartTime(video.duration, options.startTimeSeconds);
  const end = normalizedEndTime(video.duration, options.endTimeSeconds);
  const range = Math.max(0, end - start);
  const sampleCount = Math.min(50, Math.max(20, Math.floor(range / 10)));
  const differences: number[] = [];
  let previous: ImageData | undefined;

  for (let index = 0; index < sampleCount; index += 1) {
    throwIfAborted(signal);
    const fraction = sampleCount <= 1 ? 0 : index / (sampleCount - 1);
    const time = start + range * fraction;
    await seekVideo(video, time, options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS, signal);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const current = context.getImageData(0, 0, canvas.width, canvas.height);
    if (previous) differences.push(calculateImageDifference(previous, current));
    previous = current;
    emit(onProgress, {
      stage: "analyzing",
      current: index + 1,
      total: sampleCount,
      percent: ((index + 1) / sampleCount) * 100,
      message: "正在计算动态画面阈值",
    });
  }

  return computeDynamicThreshold(differences);
}

export async function extractKeyFrames(
  video: HTMLVideoElement,
  analysisCanvas: HTMLCanvasElement,
  captureCanvas: HTMLCanvasElement,
  threshold: number,
  options: ConversionOptions = {},
  onProgress?: ConversionProgressHandler,
  signal?: AbortSignal,
): Promise<CapturedFrame[]> {
  const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
  const captureContext = captureCanvas.getContext("2d");
  if (!analysisContext || !captureContext) throw new Error("无法创建关键帧提取画布。");
  resizeAnalysisCanvas(analysisCanvas, video, options.analysisWidth ?? DEFAULT_ANALYSIS_WIDTH);
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;

  const start = normalizedStartTime(video.duration, options.startTimeSeconds);
  const end = normalizedEndTime(video.duration, options.endTimeSeconds);
  const interval = positiveNumber(options.captureIntervalSeconds, DEFAULT_CAPTURE_INTERVAL_SECONDS);
  const maxSlides = positiveInteger(options.maxSlides, DEFAULT_MAX_SLIDES);
  const jpegQuality = boundedNumber(options.jpegQuality, DEFAULT_JPEG_QUALITY, 0.1, 1);
  const totalSamples = Math.max(1, Math.floor((end - start) / interval) + 1);
  const frames: CapturedFrame[] = [];
  let previous: ImageData | undefined;

  for (let index = 0; index < totalSamples && frames.length < maxSlides; index += 1) {
    throwIfAborted(signal);
    const time = Math.min(end, start + index * interval);
    await seekVideo(video, time, options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS, signal);
    analysisContext.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
    const current = analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
    const difference = previous ? calculateImageDifference(previous, current) : undefined;
    const shouldCapture = previous === undefined || (difference ?? 0) > threshold;
    if (shouldCapture) {
      captureContext.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
      frames.push({
        blob: await canvasToBlob(captureCanvas, jpegQuality),
        timeSeconds: time,
        width: captureCanvas.width,
        height: captureCanvas.height,
        difference,
      });
    }
    previous = current;
    emit(onProgress, {
      stage: "extracting",
      current: index + 1,
      total: totalSamples,
      percent: ((index + 1) / totalSamples) * 100,
      capturedFrames: frames.length,
      message: `已提取 ${frames.length} 张有效幻灯片`,
    });
  }

  return frames;
}

async function loadVideo(
  video: HTMLVideoElement,
  mediaUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("加载视频超时。"))), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const finish = (operation: () => void): void => {
      cleanup();
      operation();
    };
    const onLoaded = (): void =>
      finish(() => {
        if (
          !Number.isFinite(video.duration) ||
          video.duration <= 0 ||
          !video.videoWidth ||
          !video.videoHeight
        ) {
          reject(new Error("视频元数据无效。"));
        } else resolve();
      });
    const onError = (): void => finish(() => reject(new Error(mediaErrorMessage(video.error))));
    const onAbort = (): void => finish(() => reject(abortError()));
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.src = mediaUrl;
    video.load();
  });
}

async function seekVideo(
  video: HTMLVideoElement,
  requestedTime: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const target = Math.max(0, Math.min(requestedTime, Math.max(0, video.duration - 0.05)));
  if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForDecodedFrame(video);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error(`视频定位超时（${target.toFixed(1)} 秒）。`))),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const finish = (operation: () => void): void => {
      cleanup();
      operation();
    };
    const onSeeked = (): void => finish(resolve);
    const onError = (): void => finish(() => reject(new Error(mediaErrorMessage(video.error))));
    const onAbort = (): void => finish(() => reject(abortError()));
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.currentTime = target;
  });
  await waitForDecodedFrame(video);
}

function waitForDecodedFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    video.requestVideoFrameCallback(finish);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

function resizeAnalysisCanvas(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  requestedWidth: number,
): void {
  const width = Math.max(64, Math.min(Math.round(requestedWidth), video.videoWidth));
  canvas.width = width;
  canvas.height = Math.max(36, Math.round((video.videoHeight / video.videoWidth) * width));
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法导出关键帧图片。"))),
      "image/jpeg",
      quality,
    );
  });
}

function normalizedStartTime(duration: number, value?: number): number {
  return Math.max(0, Math.min(Number.isFinite(value) ? (value ?? 0) : 0, Math.max(0, duration - 0.05)));
}

function normalizedEndTime(duration: number, value?: number): number {
  const requested = Number.isFinite(value) ? (value ?? duration) : duration;
  return Math.max(0, Math.min(requested, Math.max(0, duration - 0.05)));
}

function mediaErrorMessage(error: MediaError | null): string {
  return error ? `视频解码失败（MediaError ${error.code}）。` : "视频解码失败。";
}

function emit(handler: ConversionProgressHandler | undefined, progress: ConversionProgress): void {
  try {
    handler?.(progress);
  } catch {
    // UI callbacks must not interrupt conversion.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("视频转换已取消。", "AbortError");
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}
