export type DocumentExportStage =
  "converting-pdf" | "extracting-images" | "recognizing-text" | "writing-text" | "validating";

export interface DocumentExportProgress {
  stage: DocumentExportStage;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export type DocumentExportProgressHandler = (progress: DocumentExportProgress) => void;

export interface DocumentExportOptions {
  title: string;
  workingDirectory: string;
  rapidOcrExecutablePath: string;
  sofficeBinaryPaths?: string[];
  signal?: AbortSignal;
  onProgress?: DocumentExportProgressHandler;
  pdfTimeoutMs?: number;
  ocrInitializationTimeoutMs?: number;
  ocrPageTimeoutMs?: number;
}

export interface DocumentExportResult {
  pdf: Uint8Array;
  text: string;
  pdfPageCount?: number;
  recognizedImageCount: number;
}

export interface OcrTextBlock {
  text: string;
  score: number;
  box: [[number, number], [number, number], [number, number], [number, number]];
}

export interface OcrResponse {
  code: number;
  data: OcrTextBlock[] | string;
}
