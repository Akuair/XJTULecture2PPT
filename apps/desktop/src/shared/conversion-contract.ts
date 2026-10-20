import type { ConversionOptions, ConversionProgress } from "@xjtu-lecture2ppt/video-to-ppt-core";

export type ConversionJobStatus =
  | "queued"
  | "loading"
  | "analyzing"
  | "extracting"
  | "generating-ppt"
  | "converting-pdf"
  | "recognizing-text"
  | "writing-output"
  | "writing"
  | "cleaning"
  | "completed"
  | "failed"
  | "cancelled";

export interface StartConversionRequest {
  downloadJobId: string;
  title?: string;
  cleanupSourceAfterSuccess?: boolean;
  options?: ConversionOptions;
}

export interface ConversionJobSnapshot {
  id: string;
  downloadJobId: string;
  status: ConversionJobStatus;
  stage?: ConversionProgress["stage"];
  current?: number;
  total?: number;
  percent?: number;
  capturedFrames?: number;
  threshold?: number;
  durationSeconds?: number;
  pdfPath?: string;
  textPath?: string;
  // Legacy primary path retained for persisted jobs and older renderer code.
  outputPath?: string;
  sourceDeleted?: boolean;
  error?: string;
}

export interface ConversionRendererTask {
  id: string;
  mediaUrl: string;
  options: ConversionOptions;
}

export interface ConversionRendererResult {
  durationSeconds: number;
  analyzedEndTimeSeconds: number;
  threshold: number;
  capturedFrameCount: number;
}
