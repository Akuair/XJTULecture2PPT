export type DownloadJobStatus =
  "queued" | "resolving-video" | "downloading" | "downloaded" | "cleaned" | "failed" | "cancelled";

export interface StartDownloadRequest {
  courseId: string;
  activityId: string;
  videoId: string;
}

export interface DownloadJobSnapshot {
  id: string;
  status: DownloadJobStatus;
  courseId: string;
  activityId: string;
  videoId: string;
  viewType?: string;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  attempt?: number;
  resumed?: boolean;
  outputPath?: string;
  sourceDeletedAt?: string;
  errorCode?: string;
  error?: string;
  updatedAt?: string;
}
