export type ConversionStage = "loading" | "analyzing" | "extracting" | "generating-ppt";

export interface ConversionOptions {
  title?: string;
  maxSlides?: number;
  threshold?: number;
  captureIntervalSeconds?: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
  jpegQuality?: number;
  analysisWidth?: number;
  seekTimeoutMs?: number;
}

export interface ConversionProgress {
  stage: ConversionStage;
  current?: number;
  total?: number;
  percent?: number;
  capturedFrames?: number;
  message?: string;
}

export interface ConversionResult {
  pptx: ArrayBuffer;
  durationSeconds: number;
  analyzedEndTimeSeconds: number;
  threshold: number;
  capturedFrameCount: number;
}

export interface CapturedFrame {
  blob: Blob;
  timeSeconds: number;
  width: number;
  height: number;
  difference?: number;
}

export type ConversionProgressHandler = (progress: ConversionProgress) => void;
