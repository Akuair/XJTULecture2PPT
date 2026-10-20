import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ConversionJobSnapshot, StartConversionRequest } from "../shared/conversion-contract";
import type { DownloadJobSnapshot, StartDownloadRequest } from "../shared/download-contract";
import type { PipelineJobSnapshot } from "../shared/pipeline-contract";
import { PipelineService } from "./pipeline-service";
import type { PipelinePersistence } from "./pipeline-store";

class FakeDownloads {
  readonly jobId = randomUUID();
  readonly listeners = new Set<(snapshot: DownloadJobSnapshot) => void>();
  readonly starts: StartDownloadRequest[] = [];

  start(request: StartDownloadRequest): DownloadJobSnapshot {
    this.starts.push(request);
    return this.snapshot("queued");
  }

  cancel(): DownloadJobSnapshot {
    return this.snapshot("cancelled");
  }

  retry(): DownloadJobSnapshot {
    return this.snapshot("queued");
  }

  async list(): Promise<DownloadJobSnapshot[]> {
    return [this.snapshot("downloaded")];
  }

  async discardTemporaryMedia(): Promise<void> {}

  subscribe(listener: (snapshot: DownloadJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(status: DownloadJobSnapshot["status"], extra: Partial<DownloadJobSnapshot> = {}): void {
    const snapshot = this.snapshot(status, extra);
    for (const listener of this.listeners) listener(snapshot);
  }

  private snapshot(
    status: DownloadJobSnapshot["status"],
    extra: Partial<DownloadJobSnapshot> = {},
  ): DownloadJobSnapshot {
    return {
      id: this.jobId,
      status,
      courseId: "100",
      activityId: "200",
      videoId: "300",
      downloadedBytes: 0,
      ...extra,
    };
  }
}

class FakeConversions {
  readonly jobId = randomUUID();
  readonly listeners = new Set<(snapshot: ConversionJobSnapshot) => void>();
  readonly starts: StartConversionRequest[] = [];

  async start(request: StartConversionRequest): Promise<ConversionJobSnapshot> {
    this.starts.push(request);
    return this.snapshot("queued");
  }

  cancel(): ConversionJobSnapshot {
    return this.snapshot("cancelled");
  }

  subscribe(listener: (snapshot: ConversionJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(status: ConversionJobSnapshot["status"], extra: Partial<ConversionJobSnapshot> = {}): void {
    const snapshot = this.snapshot(status, extra);
    for (const listener of this.listeners) listener(snapshot);
  }

  private snapshot(
    status: ConversionJobSnapshot["status"],
    extra: Partial<ConversionJobSnapshot> = {},
  ): ConversionJobSnapshot {
    return {
      id: this.jobId,
      downloadJobId: randomUUID(),
      status,
      ...extra,
    };
  }
}

class MemoryPersistence implements PipelinePersistence {
  jobs: Parameters<PipelinePersistence["save"]>[0] = [];

  async load(): Promise<Parameters<PipelinePersistence["save"]>[0]> {
    return structuredClone(this.jobs);
  }

  async save(jobs: Parameters<PipelinePersistence["save"]>[0]): Promise<void> {
    this.jobs = structuredClone(jobs);
  }
}

describe("PipelineService", () => {
  it("orchestrates download, conversion, verified write, and cleanup", async () => {
    const downloads = new FakeDownloads();
    const conversions = new FakeConversions();
    const updates: PipelineJobSnapshot[] = [];
    const service = new PipelineService(downloads, conversions, (snapshot) => updates.push(snapshot));

    const started = await service.start({
      courseId: "100",
      activityId: "200",
      videoId: "300",
      title: "测试课程_视角1",
      options: { endTimeSeconds: 180 },
    });
    downloads.emit("resolving-video");
    downloads.emit("downloading", { downloadedBytes: 50, totalBytes: 100, percent: 50 });
    downloads.emit("downloaded", { downloadedBytes: 100, totalBytes: 100, percent: 100 });

    await vi.waitFor(() => expect(conversions.starts).toHaveLength(1));
    expect(conversions.starts[0]).toMatchObject({
      downloadJobId: downloads.jobId,
      cleanupSourceAfterSuccess: true,
    });
    conversions.emit("converting-pdf");
    conversions.emit("recognizing-text");
    conversions.emit("writing-output", {
      pdfPath: "C:\\output\\lecture.pdf",
      textPath: "C:\\output\\lecture.txt",
    });
    conversions.emit("cleaning", {
      pdfPath: "C:\\output\\lecture.pdf",
      textPath: "C:\\output\\lecture.txt",
    });
    conversions.emit("completed", {
      pdfPath: "C:\\output\\lecture.pdf",
      textPath: "C:\\output\\lecture.txt",
      outputPath: "C:\\output\\lecture.pdf",
      sourceDeleted: true,
    });

    const final = (await service.list()).find((job) => job.id === started.id);
    expect(final).toMatchObject({
      status: "completed",
      downloadedBytes: 100,
      pdfPath: "C:\\output\\lecture.pdf",
      textPath: "C:\\output\\lecture.txt",
      sourceDeleted: true,
    });
    expect(updates.map((update) => update.status)).toEqual(
      expect.arrayContaining([
        "queued",
        "authenticating",
        "resolving-video",
        "downloading",
        "downloaded",
        "converting",
        "converting-pdf",
        "recognizing-text",
        "writing-output",
        "cleaning",
        "completed",
      ]),
    );
  });

  it("reports an authenticated download failure without starting conversion", async () => {
    const downloads = new FakeDownloads();
    const conversions = new FakeConversions();
    const service = new PipelineService(downloads, conversions, () => undefined);
    const started = await service.start({
      courseId: "100",
      activityId: "200",
      videoId: "300",
      title: "测试课程",
    });

    downloads.emit("failed", { error: "西交登录已经过期，请重新登录。" });

    expect((await service.list()).find((job) => job.id === started.id)).toMatchObject({
      status: "failed",
      error: "西交登录已经过期，请重新登录。",
    });
    expect(conversions.starts).toHaveLength(0);
  });

  it("persists jobs and marks interrupted work as recoverable after restart", async () => {
    const downloads = new FakeDownloads();
    const conversions = new FakeConversions();
    const persistence = new MemoryPersistence();
    const first = new PipelineService(downloads, conversions, () => undefined, persistence);
    const started = await first.start({
      courseId: "100",
      activityId: "200",
      videoId: "300",
      title: "病理生理学_2026-08-21_第01讲_视角1",
    });

    const restored = new PipelineService(
      new FakeDownloads(),
      new FakeConversions(),
      () => undefined,
      persistence,
    );
    const jobs = await restored.list();

    expect(jobs.find((job) => job.id === started.id)).toMatchObject({
      status: "failed",
      title: "病理生理学_2026-08-21_第01讲_视角1",
    });
    expect(jobs[0]?.error).toContain("应用上次");
  });
});
