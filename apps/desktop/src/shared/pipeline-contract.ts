import type { ConversionOptions } from "@xjtu-lecture2ppt/video-to-ppt-core";
import type { JobStatus } from "@xjtu-lecture2ppt/shared";

export interface StartPipelineRequest {
  courseId: string;
  activityId: string;
  videoId: string;
  title: string;
  options?: ConversionOptions;
}

export interface PipelineJobSnapshot {
  id: string;
  status: JobStatus;
  courseId: string;
  activityId: string;
  videoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  downloadJobId?: string;
  conversionJobId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  capturedFrames?: number;
  pdfPath?: string;
  textPath?: string;
  // Legacy primary path retained for persisted jobs.
  outputPath?: string;
  sourceDeleted?: boolean;
  temporaryFilesDeletedAt?: string;
  error?: string;
}

export interface PersistedPipelineJob {
  version: 1;
  request: StartPipelineRequest;
  snapshot: PipelineJobSnapshot;
}
