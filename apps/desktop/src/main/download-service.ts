import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DownloadError, downloadToFile } from "@xjtu-lecture2ppt/downloader";
import { XjtuApiError } from "@xjtu-lecture2ppt/xjtu-client";
import { app } from "electron";

import type { DownloadJobSnapshot, StartDownloadRequest } from "../shared/download-contract";
import { log } from "./logger";
import { cleanupJobTemporaryFiles, discardJobTemporaryFiles } from "./temporary-files";
import { XjtuService } from "./xjtu-service";

const CLASS_ORIGIN = "https://class.xjtu.edu.cn";

interface InternalDownloadJob {
  request: StartDownloadRequest;
  snapshot: DownloadJobSnapshot;
  controller?: AbortController;
}

export class DownloadService {
  private readonly jobs = new Map<string, InternalDownloadJob>();
  private readonly listeners = new Set<(snapshot: DownloadJobSnapshot) => void>();

  constructor(
    private readonly xjtu: XjtuService,
    private readonly notify: (snapshot: DownloadJobSnapshot) => void,
    private readonly getMaxConcurrentDownloads: () => number = () => 2,
  ) {}

  start(request: StartDownloadRequest): DownloadJobSnapshot {
    this.assertCapacity();
    const id = randomUUID();
    const job: InternalDownloadJob = {
      request,
      snapshot: {
        id,
        status: "queued",
        courseId: request.courseId,
        activityId: request.activityId,
        videoId: request.videoId,
        downloadedBytes: 0,
      },
    };
    this.jobs.set(id, job);
    this.emit(job);
    void this.run(job);
    return cloneSnapshot(job.snapshot);
  }

  retry(jobId: string): DownloadJobSnapshot {
    const job = this.requireJob(jobId);
    if (job.controller) throw new Error("该下载任务仍在运行。");
    if (job.snapshot.status !== "failed" && job.snapshot.status !== "cancelled") {
      throw new Error("只有失败或已取消的下载任务可以重试。");
    }
    this.assertCapacity();
    Object.assign(job.snapshot, {
      status: "queued",
      error: undefined,
      errorCode: undefined,
      percent: undefined,
    } satisfies Partial<DownloadJobSnapshot>);
    this.emit(job);
    void this.run(job);
    return cloneSnapshot(job.snapshot);
  }

  cancel(jobId: string): DownloadJobSnapshot {
    const job = this.requireJob(jobId);
    if (job.controller) job.controller.abort();
    else if (job.snapshot.status === "queued") {
      job.snapshot.status = "cancelled";
      this.emit(job);
    }
    return cloneSnapshot(job.snapshot);
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.controller?.abort();
  }

  subscribe(listener: (snapshot: DownloadJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<DownloadJobSnapshot[]> {
    await mkdir(this.jobsRoot, { recursive: true });
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isJobId(entry.name) || this.jobs.has(entry.name)) continue;
      const restored = await this.restoreJob(entry.name);
      if (restored) this.jobs.set(entry.name, restored);
    }
    return [...this.jobs.values()]
      .map((job) => cloneSnapshot(job.snapshot))
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  async getCompletedSourcePath(jobId: string): Promise<string> {
    if (!this.jobs.has(jobId)) await this.list();
    const job = this.requireJob(jobId);
    if (job.snapshot.status !== "downloaded") throw new Error("该任务尚未完成视频下载。");
    const sourcePath = join(this.jobsRoot, jobId, "source.mp4");
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error("下载完成的视频文件不存在或为空。");
    return sourcePath;
  }

  async cleanupTemporaryMedia(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) await this.list();
    const job = this.requireJob(jobId);
    if (job.snapshot.status === "cleaned") return;
    if (job.snapshot.status !== "downloaded") {
      throw new Error("只有下载完成的视频可以执行自动清理。");
    }

    const result = await cleanupJobTemporaryFiles(this.jobsRoot, jobId);
    job.snapshot.status = "cleaned";
    job.snapshot.outputPath = undefined;
    job.snapshot.sourceDeletedAt = new Date().toISOString();
    job.snapshot.updatedAt = job.snapshot.sourceDeletedAt;
    job.snapshot.error = undefined;
    job.snapshot.errorCode = undefined;
    await this.writeMetadata(join(this.jobsRoot, jobId), job).catch((error: unknown) => {
      log("CLEANUP", "Temporary media was deleted but metadata update failed", {
        jobId,
        diagnostic: summarizeError(error),
      });
    });
    this.emit(job);
    log("CLEANUP", "Verified PPTX exists; temporary source video deleted", {
      jobId,
      bytes: result.sourceBytes,
      framesRemoved: result.framesRemoved,
    });
  }

  async discardTemporaryMedia(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) await this.list();
    const job = this.requireJob(jobId);
    if (job.controller) throw new Error("任务仍在运行，请先取消后再删除临时文件。");
    await discardJobTemporaryFiles(this.jobsRoot, jobId);
    const now = new Date().toISOString();
    Object.assign(job.snapshot, {
      status: "cleaned",
      outputPath: undefined,
      sourceDeletedAt: now,
      updatedAt: now,
      error: undefined,
      errorCode: undefined,
    } satisfies Partial<DownloadJobSnapshot>);
    await this.writeMetadata(join(this.jobsRoot, jobId), job);
    this.emit(job);
    log("CLEANUP", "Temporary files removed by user", { jobId });
  }

  private async run(job: InternalDownloadJob): Promise<void> {
    const controller = new AbortController();
    job.controller = controller;
    const jobDirectory = join(this.jobsRoot, job.snapshot.id);
    const destinationPath = join(jobDirectory, "source.mp4");

    try {
      await mkdir(jobDirectory, { recursive: true });
      await this.writeMetadata(jobDirectory, job);
      const result = await downloadToFile(
        {
          destinationPath,
          signal: controller.signal,
          timeoutMs: 45_000,
          maxRetries: 2,
          retryDelayMs: 1_000,
          resume: true,
          fetch: (input, init) => this.xjtu.fetchAuthorizedMedia(input, init),
          resolveSource: async () => {
            job.snapshot.status = "resolving-video";
            this.emit(job);
            let video;
            try {
              video = await this.xjtu.resolveLectureVideo(
                job.request.courseId,
                job.request.activityId,
                job.request.videoId,
              );
            } catch (error) {
              throw mapXjtuError(error);
            }
            if (!video.url) {
              throw new DownloadError("INVALID_MEDIA_RESPONSE", "该视频视角没有可用播放地址。", {
                retryable: true,
              });
            }
            job.snapshot.viewType = video.viewType;
            return {
              url: video.url,
              streamType: video.streamType,
              headers: {
                Accept: "*/*",
                Origin: CLASS_ORIGIN,
                Referer: `${CLASS_ORIGIN}/`,
              },
            };
          },
        },
        (progress) => {
          job.snapshot.status = progress.stage === "resolving" ? "resolving-video" : "downloading";
          job.snapshot.downloadedBytes = progress.downloadedBytes;
          job.snapshot.totalBytes = progress.totalBytes;
          job.snapshot.percent = progress.percent;
          job.snapshot.attempt = progress.attempt;
          job.snapshot.resumed = progress.resumed;
          this.emit(job);
        },
      );

      Object.assign(job.snapshot, {
        status: "downloaded",
        downloadedBytes: result.downloadedBytes,
        totalBytes: result.totalBytes,
        percent: 100,
        attempt: result.attempts,
        resumed: result.resumed,
        outputPath: result.destinationPath,
        error: undefined,
        errorCode: undefined,
      } satisfies Partial<DownloadJobSnapshot>);
      await this.writeMetadata(jobDirectory, job);
      log("DOWNLOAD", "Authenticated video download completed", {
        jobId: job.snapshot.id,
        bytes: result.downloadedBytes,
        attempts: result.attempts,
      });
    } catch (error) {
      const failure = error instanceof DownloadError ? error : mapXjtuError(error);
      job.snapshot.status = failure.code === "CANCELLED" ? "cancelled" : "failed";
      job.snapshot.errorCode = failure.code;
      job.snapshot.error = failure.message;
      await this.writeMetadata(jobDirectory, job).catch(() => undefined);
      log("DOWNLOAD", "Authenticated video download stopped", {
        jobId: job.snapshot.id,
        status: job.snapshot.status,
        errorCode: failure.code,
        diagnostic: summarizeError(failure),
      });
    } finally {
      job.controller = undefined;
      this.emit(job);
    }
  }

  private emit(job: InternalDownloadJob): void {
    const snapshot = cloneSnapshot(job.snapshot);
    this.notify(snapshot);
    for (const listener of this.listeners) listener(cloneSnapshot(snapshot));
  }

  private assertCapacity(): void {
    const active = [...this.jobs.values()].filter((job) => job.controller).length;
    const limit = Math.max(1, Math.min(2, this.getMaxConcurrentDownloads()));
    if (active >= limit) throw new Error(`当前下载任务已达到并发上限（${limit}）。`);
  }

  getJobsRoot(): string {
    return this.jobsRoot;
  }

  private requireJob(jobId: string): InternalDownloadJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("下载任务不存在或应用已经重启。");
    return job;
  }

  private async writeMetadata(directory: string, job: InternalDownloadJob): Promise<void> {
    job.snapshot.updatedAt = new Date().toISOString();
    const metadata = {
      version: 1,
      id: job.snapshot.id,
      courseId: job.request.courseId,
      activityId: job.request.activityId,
      videoId: job.request.videoId,
      viewType: job.snapshot.viewType,
      status: job.snapshot.status,
      downloadedBytes: job.snapshot.downloadedBytes,
      totalBytes: job.snapshot.totalBytes,
      errorCode: job.snapshot.errorCode,
      error: job.snapshot.error,
      sourceDeletedAt: job.snapshot.sourceDeletedAt,
      updatedAt: job.snapshot.updatedAt,
    };
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  }

  private async restoreJob(jobId: string): Promise<InternalDownloadJob | undefined> {
    try {
      const directory = join(this.jobsRoot, jobId);
      const parsed = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const request: StartDownloadRequest = {
        courseId: storedNumericId(parsed.courseId),
        activityId: storedNumericId(parsed.activityId),
        videoId: storedNumericId(parsed.videoId),
      };
      const status = storedStatus(parsed.status);
      const sourcePath = join(directory, "source.mp4");
      const completedSize = await stat(sourcePath)
        .then((value) => value.size)
        .catch(() => 0);
      const partSize = await stat(`${sourcePath}.part`)
        .then((value) => value.size)
        .catch(() => 0);
      const restoredStatus =
        completedSize > 0
          ? "downloaded"
          : status === "cleaned"
            ? "cleaned"
            : status === "downloaded"
              ? "failed"
              : status;
      return {
        request,
        snapshot: {
          id: jobId,
          status: restoredStatus,
          ...request,
          viewType: storedOptionalString(parsed.viewType),
          downloadedBytes: completedSize || partSize || storedNumber(parsed.downloadedBytes) || 0,
          totalBytes: storedNumber(parsed.totalBytes),
          percent: completedSize > 0 ? 100 : undefined,
          outputPath: completedSize > 0 ? sourcePath : undefined,
          sourceDeletedAt: storedOptionalString(parsed.sourceDeletedAt),
          errorCode: storedOptionalString(parsed.errorCode),
          error:
            status === "downloaded" && completedSize === 0
              ? "已下载的视频文件不存在，无法继续转换。"
              : storedOptionalString(parsed.error),
          updatedAt: storedOptionalString(parsed.updatedAt),
        },
      };
    } catch {
      return undefined;
    }
  }

  private get jobsRoot(): string {
    return join(app.getPath("userData"), "temp", "jobs");
  }
}

function mapXjtuError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  if (error instanceof XjtuApiError) {
    if (error.code === "AUTH_REQUIRED") {
      return new DownloadError("AUTH_REQUIRED", "西交登录已经过期，请重新登录。", {
        status: error.status,
      });
    }
    if (error.code === "FORBIDDEN") {
      return new DownloadError("FORBIDDEN", "当前账号无权访问该课堂视频。", {
        status: error.status,
      });
    }
    if (error.code === "SERVER_ERROR" || error.code === "HTTP_ERROR") {
      return new DownloadError("HTTP_ERROR", error.message, {
        retryable: true,
        status: error.status,
      });
    }
    return new DownloadError("INVALID_MEDIA_RESPONSE", error.message, { status: error.status });
  }
  return new DownloadError("HTTP_ERROR", "视频下载失败，可重新下载。", {
    retryable: false,
    cause: error,
  });
}

function cloneSnapshot(snapshot: DownloadJobSnapshot): DownloadJobSnapshot {
  return { ...snapshot };
}

function isJobId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function storedNumericId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid stored ID");
  return value;
}

function storedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function storedOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function storedStatus(value: unknown): DownloadJobSnapshot["status"] {
  if (
    value === "queued" ||
    value === "resolving-video" ||
    value === "downloading" ||
    value === "downloaded" ||
    value === "cleaned" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "failed";
}

function summarizeError(error: unknown, depth = 0): unknown {
  if (depth >= 3 || !error || typeof error !== "object") return undefined;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    message: typeof candidate.message === "string" ? candidate.message : undefined,
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    cause: summarizeError(candidate.cause, depth + 1),
  };
}
