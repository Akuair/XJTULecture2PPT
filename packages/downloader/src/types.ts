export type DownloadStreamType = "mp4" | "hls" | "dash" | "unknown";

export type DownloadStage = "preparing" | "resolving" | "downloading" | "retrying" | "completed";

export interface DownloadSource {
  url: string;
  streamType?: DownloadStreamType;
  headers?: HeadersInit;
}

export interface DownloadProgress {
  stage: DownloadStage;
  attempt: number;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  resumed: boolean;
}

export interface DownloadResult {
  destinationPath: string;
  downloadedBytes: number;
  totalBytes?: number;
  resumed: boolean;
  attempts: number;
  contentType?: string;
}

export type DownloadFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StreamingDownloadRequest {
  destinationPath: string;
  fetch: DownloadFetch;
  resolveSource(attempt: number): Promise<DownloadSource>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  resume?: boolean;
}

export type DownloadProgressHandler = (progress: DownloadProgress) => void;
