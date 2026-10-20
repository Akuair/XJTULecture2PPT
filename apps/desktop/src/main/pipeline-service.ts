import { randomUUID } from "node:crypto";

import { transitionJobStatus } from "@xjtu-lecture2ppt/shared";

import type { ConversionJobSnapshot } from "../shared/conversion-contract";
import type { DownloadJobSnapshot } from "../shared/download-contract";
import type {
  PersistedPipelineJob,
  PipelineJobSnapshot,
  StartPipelineRequest,
} from "../shared/pipeline-contract";
import { log } from "./logger";
import type { PipelinePersistence } from "./pipeline-store";

interface DownloadOperations {
  start(request: { courseId: string; activityId: string; videoId: string }): DownloadJobSnapshot;
  retry(jobId: string): DownloadJobSnapshot;
  cancel(jobId: string): DownloadJobSnapshot;
  list(): Promise<DownloadJobSnapshot[]>;
  discardTemporaryMedia(jobId: string): Promise<void>;
  subscribe(listener: (snapshot: DownloadJobSnapshot) => void): () => void;
}

interface ConversionOperations {
  start(request: {
    downloadJobId: string;
    title?: string;
    cleanupSourceAfterSuccess?: boolean;
    options?: StartPipelineRequest["options"];
  }): Promise<ConversionJobSnapshot>;
  cancel(jobId: string): ConversionJobSnapshot;
  subscribe(listener: (snapshot: ConversionJobSnapshot) => void): () => void;
}

interface InternalPipelineJob {
  request: StartPipelineRequest;
  snapshot: PipelineJobSnapshot;
  conversionStarting: boolean;
}

export class PipelineService {
  private readonly jobs = new Map<string, InternalPipelineJob>();
  private initialization?: Promise<void>;
  private persistenceQueue = Promise.resolve();

  constructor(
    private readonly downloads: DownloadOperations,
    private readonly conversions: ConversionOperations,
    private readonly notify: (snapshot: PipelineJobSnapshot) => void,
    private readonly persistence?: PipelinePersistence,
    private readonly shouldCleanupSource: () => boolean = () => true,
  ) {
    downloads.subscribe((snapshot) => this.handleDownloadUpdate(snapshot));
    conversions.subscribe((snapshot) => this.handleConversionUpdate(snapshot));
  }

  initialize(): Promise<void> {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  async start(request: StartPipelineRequest): Promise<PipelineJobSnapshot> {
    await this.initialize();
    if ([...this.jobs.values()].some((job) => !isTerminal(job.snapshot.status))) {
      throw new Error("当前已有生成任务正在运行。");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: InternalPipelineJob = {
      request,
      conversionStarting: false,
      snapshot: {
        id,
        status: "queued",
        courseId: request.courseId,
        activityId: request.activityId,
        videoId: request.videoId,
        title: request.title,
        createdAt: now,
        updatedAt: now,
        downloadedBytes: 0,
        percent: 0,
      },
    };
    this.jobs.set(id, job);
    this.emit(job);
    this.move(job, "authenticating");
    try {
      const download = this.downloads.start(pickDownloadRequest(request));
      job.snapshot.downloadJobId = download.id;
      this.emit(job);
    } catch (error) {
      this.fail(job, messageOf(error));
    }
    await this.flushPersistence();
    return cloneSnapshot(job.snapshot);
  }

  async list(): Promise<PipelineJobSnapshot[]> {
    await this.initialize();
    await this.flushPersistence();
    return [...this.jobs.values()]
      .map((job) => cloneSnapshot(job.snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async retry(jobId: string): Promise<PipelineJobSnapshot> {
    await this.initialize();
    const job = this.requireJob(jobId);
    if (job.snapshot.status !== "failed" && job.snapshot.status !== "cancelled") {
      throw new Error("只有失败或已取消的任务可以重试。");
    }
    if (
      [...this.jobs.values()].some((candidate) => candidate !== job && !isTerminal(candidate.snapshot.status))
    ) {
      throw new Error("当前已有生成任务正在运行。");
    }
    job.snapshot.error = undefined;
    job.snapshot.temporaryFilesDeletedAt = undefined;
    this.move(job, "queued");

    const download = job.snapshot.downloadJobId
      ? (await this.downloads.list()).find((candidate) => candidate.id === job.snapshot.downloadJobId)
      : undefined;
    try {
      if (download?.status === "downloaded") {
        this.move(job, "downloaded");
        await this.startConversion(job);
      } else {
        this.move(job, "authenticating");
        const restarted =
          download && (download.status === "failed" || download.status === "cancelled")
            ? this.downloads.retry(download.id)
            : this.downloads.start(pickDownloadRequest(job.request));
        job.snapshot.downloadJobId = restarted.id;
        job.snapshot.conversionJobId = undefined;
        job.snapshot.downloadedBytes = restarted.downloadedBytes;
        job.snapshot.percent = restarted.percent ?? 0;
        this.emit(job);
      }
    } catch (error) {
      this.fail(job, messageOf(error));
    }
    await this.flushPersistence();
    return cloneSnapshot(job.snapshot);
  }

  async cancel(jobId: string): Promise<PipelineJobSnapshot> {
    await this.initialize();
    const job = this.requireJob(jobId);
    if (isTerminal(job.snapshot.status)) return cloneSnapshot(job.snapshot);
    if (job.snapshot.conversionJobId) this.conversions.cancel(job.snapshot.conversionJobId);
    else if (job.snapshot.downloadJobId) this.downloads.cancel(job.snapshot.downloadJobId);
    this.move(job, "cancelled");
    await this.flushPersistence();
    return cloneSnapshot(job.snapshot);
  }

  async deleteTemporaryFiles(jobId: string): Promise<PipelineJobSnapshot> {
    await this.initialize();
    const job = this.requireJob(jobId);
    if (!isTerminal(job.snapshot.status)) throw new Error("请先取消任务，再删除临时文件。");
    if (!job.snapshot.downloadJobId) throw new Error("该任务没有可删除的临时文件。");
    await this.downloads.discardTemporaryMedia(job.snapshot.downloadJobId);
    job.snapshot.sourceDeleted = true;
    job.snapshot.temporaryFilesDeletedAt = new Date().toISOString();
    this.emit(job);
    await this.flushPersistence();
    return cloneSnapshot(job.snapshot);
  }

  private async restore(): Promise<void> {
    if (!this.persistence) return;
    const stored = await this.persistence.load();
    for (const value of stored) {
      const parsed = parsePersisted(value);
      if (!parsed || this.jobs.has(parsed.snapshot.id)) continue;
      if (!isTerminal(parsed.snapshot.status)) {
        parsed.snapshot.status = "failed";
        parsed.snapshot.error = "应用上次在任务执行期间退出。临时视频若仍存在，可点击重新处理。";
        parsed.snapshot.updatedAt = new Date().toISOString();
      }
      this.jobs.set(parsed.snapshot.id, { ...parsed, conversionStarting: false });
    }
    if (stored.length) this.queuePersistence();
  }

  private handleDownloadUpdate(download: DownloadJobSnapshot): void {
    const job = [...this.jobs.values()].find((candidate) => candidate.snapshot.downloadJobId === download.id);
    if (!job || isTerminal(job.snapshot.status)) return;
    job.snapshot.downloadedBytes = download.downloadedBytes;
    job.snapshot.totalBytes = download.totalBytes;
    job.snapshot.percent = download.percent;

    switch (download.status) {
      case "queued":
        this.emit(job);
        break;
      case "resolving-video":
        this.move(job, "resolving-video");
        break;
      case "downloading":
        this.move(job, "downloading");
        break;
      case "downloaded":
        this.move(job, "downloaded");
        void this.startConversion(job);
        break;
      case "cleaned":
        this.emit(job);
        break;
      case "failed":
        this.fail(job, download.error || "视频下载失败，可重新下载。");
        break;
      case "cancelled":
        this.move(job, "cancelled");
        break;
    }
  }

  private async startConversion(job: InternalPipelineJob): Promise<void> {
    if (job.conversionStarting || job.snapshot.status !== "downloaded") return;
    job.conversionStarting = true;
    job.snapshot.conversionJobId = undefined;
    this.move(job, "converting");
    try {
      const conversion = await this.conversions.start({
        downloadJobId: job.snapshot.downloadJobId!,
        title: job.request.title,
        cleanupSourceAfterSuccess: this.shouldCleanupSource(),
        options: job.request.options,
      });
      job.snapshot.conversionJobId = conversion.id;
      this.emit(job);
    } catch (error) {
      this.fail(job, messageOf(error));
    } finally {
      job.conversionStarting = false;
    }
  }

  private handleConversionUpdate(conversion: ConversionJobSnapshot): void {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.snapshot.conversionJobId === conversion.id,
    );
    if (!job || isTerminal(job.snapshot.status)) return;
    job.snapshot.percent = conversion.percent;
    job.snapshot.capturedFrames = conversion.capturedFrames;
    job.snapshot.pdfPath = conversion.pdfPath;
    job.snapshot.textPath = conversion.textPath;
    job.snapshot.outputPath = conversion.outputPath;
    job.snapshot.sourceDeleted = conversion.sourceDeleted;

    switch (conversion.status) {
      case "queued":
      case "loading":
      case "analyzing":
      case "extracting":
      case "generating-ppt":
      case "writing":
        this.move(job, "converting");
        break;
      case "converting-pdf":
        this.move(job, "converting-pdf");
        break;
      case "recognizing-text":
        this.move(job, "recognizing-text");
        break;
      case "writing-output":
        this.move(job, "writing-output");
        break;
      case "cleaning":
        this.move(job, "cleaning");
        break;
      case "completed":
        this.move(job, "completed");
        log("JOB", "Download, PDF/TXT export, validation, and cleanup pipeline completed", {
          jobId: job.snapshot.id,
        });
        break;
      case "failed":
        this.fail(job, conversion.error || "PDF/TXT 生成失败，原视频已保留，可重新处理。");
        break;
      case "cancelled":
        this.move(job, "cancelled");
        break;
    }
  }

  private move(job: InternalPipelineJob, next: PipelineJobSnapshot["status"]): void {
    job.snapshot.status = transitionJobStatus(job.snapshot.status, next);
    this.emit(job);
  }

  private fail(job: InternalPipelineJob, error: string): void {
    if (job.snapshot.status !== "failed") this.move(job, "failed");
    job.snapshot.error = cleanMessage(error);
    this.emit(job);
  }

  private emit(job: InternalPipelineJob): void {
    job.snapshot.updatedAt = new Date().toISOString();
    this.notify(cloneSnapshot(job.snapshot));
    this.queuePersistence();
  }

  private queuePersistence(): void {
    if (!this.persistence) return;
    this.persistenceQueue = this.persistenceQueue
      .then(() => this.persistence!.save(this.serializedJobs()))
      .catch((error: unknown) => {
        log("JOB", "Pipeline persistence failed", { error: messageOf(error) });
      });
  }

  private flushPersistence(): Promise<void> {
    return this.persistenceQueue;
  }

  private serializedJobs(): PersistedPipelineJob[] {
    return [...this.jobs.values()].map((job) => ({
      version: 1,
      request: { ...job.request, options: job.request.options ? { ...job.request.options } : undefined },
      snapshot: cloneSnapshot(job.snapshot),
    }));
  }

  private requireJob(jobId: string): InternalPipelineJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("生成任务不存在。");
    return job;
  }
}

function parsePersisted(
  value: PersistedPipelineJob,
): Omit<InternalPipelineJob, "conversionStarting"> | undefined {
  if (
    !value ||
    value.version !== 1 ||
    !value.request ||
    !value.snapshot ||
    typeof value.snapshot.id !== "string" ||
    typeof value.snapshot.title !== "string" ||
    typeof value.snapshot.createdAt !== "string" ||
    typeof value.snapshot.updatedAt !== "string"
  ) {
    return undefined;
  }
  return { request: value.request, snapshot: { ...value.snapshot } };
}

function pickDownloadRequest(request: StartPipelineRequest): {
  courseId: string;
  activityId: string;
  videoId: string;
} {
  return {
    courseId: request.courseId,
    activityId: request.activityId,
    videoId: request.videoId,
  };
}

function cloneSnapshot(snapshot: PipelineJobSnapshot): PipelineJobSnapshot {
  return { ...snapshot };
}

function isTerminal(status: PipelineJobSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "生成任务失败。";
}

function cleanMessage(value: string): string {
  return (
    value
      .replace(/[\r\n\0]/g, " ")
      .trim()
      .slice(0, 500) || "生成任务失败。"
  );
}
