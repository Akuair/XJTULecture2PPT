import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  exportPptxToPdfAndText,
  validatePdf,
  validateText,
  type DocumentExportProgress,
} from "@xjtu-lecture2ppt/document-exporter";
import { sanitizeWindowsFileName } from "@xjtu-lecture2ppt/shared";
import type { ConversionProgress } from "@xjtu-lecture2ppt/video-to-ppt-core";
import { app, BrowserWindow, session } from "electron";

import type {
  ConversionJobSnapshot,
  ConversionRendererResult,
  ConversionRendererTask,
  StartConversionRequest,
} from "../shared/conversion-contract";
import { DownloadService } from "./download-service";
import { InternalMediaProtocol } from "./internal-media-protocol";
import { log } from "./logger";
import { validatePptxBuffer } from "./pptx-validation";

interface ActiveConversion {
  snapshot: ConversionJobSnapshot;
  task: ConversionRendererTask;
  window: BrowserWindow;
  mediaToken: string;
  outputPaths: { pdf: string; text: string };
  workingDirectory: string;
  abortController: AbortController;
  cleanupSourceAfterSuccess: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export class ConversionService {
  private readonly mediaProtocol: InternalMediaProtocol;
  private readonly listeners = new Set<(snapshot: ConversionJobSnapshot) => void>();
  private active?: ActiveConversion;

  constructor(
    private readonly downloads: DownloadService,
    private readonly notify: (snapshot: ConversionJobSnapshot) => void,
    private readonly getOutputDirectory: () => Promise<string> = async () =>
      join(app.getPath("documents"), "XJTU Lecture2PPT"),
  ) {
    const conversionSession = session.fromPartition("persist:xjtu-lecture2ppt-conversion");
    this.mediaProtocol = new InternalMediaProtocol(conversionSession);
    this.mediaProtocol.initialize();
  }

  async start(request: StartConversionRequest): Promise<ConversionJobSnapshot> {
    if (this.active) throw new Error("当前已有视频正在转换；第一版转换并发固定为 1。");
    const sourcePath = await this.downloads.getCompletedSourcePath(request.downloadJobId);
    const id = randomUUID();
    const title = request.title?.trim() || "XJTU Lecture2PPT";
    const outputPaths = await this.createOutputPaths(title, id);
    const registered = this.mediaProtocol.register(sourcePath);
    const conversionSession = session.fromPartition("persist:xjtu-lecture2ppt-conversion");
    const window = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        session: conversionSession,
        preload: join(__dirname, "../preload/conversion.cjs"),
      },
    });
    const snapshot: ConversionJobSnapshot = {
      id,
      downloadJobId: request.downloadJobId,
      status: "queued",
      stage: "loading",
      percent: 0,
    };
    const task: ConversionRendererTask = {
      id,
      mediaUrl: registered.url,
      options: { ...request.options, title },
    };
    this.active = {
      snapshot,
      task,
      window,
      mediaToken: registered.token,
      outputPaths,
      workingDirectory: dirname(sourcePath),
      abortController: new AbortController(),
      cleanupSourceAfterSuccess: request.cleanupSourceAfterSuccess === true,
    };
    this.emit(snapshot);
    log("CONVERT", "Conversion worker created", { jobId: id });
    window.webContents.once("did-finish-load", () => {
      if (this.isActive(id, window.webContents.id)) this.emit(snapshot);
    });
    window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      void this.handleFailed(
        window.webContents.id,
        id,
        `转换页面加载失败（${errorCode}: ${errorDescription}）。`,
      );
    });
    window.webContents.once("render-process-gone", (_event, details) => {
      void this.handleFailed(window.webContents.id, id, `视频转换进程意外退出（${details.reason}）。`);
    });
    window.webContents.on("preload-error", (_event, _preloadPath, error) => {
      void this.handleFailed(window.webContents.id, id, `转换组件加载失败：${error.message}`);
    });
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) log("CONVERT", "Conversion worker console error", { jobId: id, message });
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/conversion.html`);
    } else {
      await window.loadFile(join(__dirname, "../renderer/conversion.html"));
    }
    return cloneSnapshot(snapshot);
  }

  ready(senderId: number): void {
    const active = this.active;
    if (!active || active.window.webContents.id !== senderId || active.snapshot.status === "cancelled")
      return;
    active.snapshot.status = "loading";
    this.emit(active.snapshot);
    log("CONVERT", "Conversion worker ready; task dispatched", { jobId: active.snapshot.id });
    active.window.webContents.send("conversion-worker:task", active.task);
  }

  progress(senderId: number, taskId: string, progress: ConversionProgress): void {
    if (!this.isActive(taskId, senderId)) return;
    const active = this.active;
    if (!active || active.snapshot.status === "cancelled") return;
    const previousStage = active.snapshot.stage;
    active.snapshot.status = progress.stage;
    active.snapshot.stage = progress.stage;
    active.snapshot.current = finiteNumber(progress.current);
    active.snapshot.total = finiteNumber(progress.total);
    active.snapshot.percent = boundedPercent(progress.percent);
    active.snapshot.capturedFrames = finiteNumber(progress.capturedFrames);
    this.emit(active.snapshot);
    if (previousStage !== progress.stage) {
      log("CONVERT", "Conversion stage changed", { jobId: taskId, stage: progress.stage });
    }
  }

  async complete(
    senderId: number,
    taskId: string,
    pptx: ArrayBuffer,
    result: ConversionRendererResult,
  ): Promise<void> {
    if (!this.isActive(taskId, senderId)) return;
    const active = this.active;
    if (!active || active.snapshot.status === "cancelled") return;
    const temporaryPptxPath = join(active.workingDirectory, "intermediate.pptx");
    const temporaryPptxPartPath = `${temporaryPptxPath}.part`;
    const pdfPartPath = `${active.outputPaths.pdf}.part`;
    const textPartPath = `${active.outputPaths.text}.part`;
    try {
      active.snapshot.status = "writing";
      active.snapshot.percent = 0;
      this.emit(active.snapshot);
      const validation = await validatePptxBuffer(pptx);
      await mkdir(active.workingDirectory, { recursive: true });
      await writeFile(temporaryPptxPartPath, new Uint8Array(pptx));
      const intermediate = await stat(temporaryPptxPartPath);
      if (!intermediate.isFile() || intermediate.size <= 0) throw new Error("临时 PPTX 写入后为空。");
      await unlink(temporaryPptxPath).catch(() => undefined);
      await rename(temporaryPptxPartPath, temporaryPptxPath);

      const exported = await exportPptxToPdfAndText(pptx, {
        title: active.task.options.title || "XJTU Lecture2PPT",
        workingDirectory: active.workingDirectory,
        rapidOcrExecutablePath: await this.resolveRapidOcrExecutable(),
        sofficeBinaryPaths: this.sofficeBinaryPaths(),
        signal: active.abortController.signal,
        onProgress: (progress) => this.documentProgress(active, progress),
      });

      active.snapshot.status = "writing-output";
      active.snapshot.percent = 0;
      this.emit(active.snapshot);
      await mkdir(dirname(active.outputPaths.pdf), { recursive: true });
      validatePdf(exported.pdf);
      validateText(exported.text);
      await Promise.all([
        writeFile(pdfPartPath, exported.pdf),
        writeFile(textPartPath, exported.text, "utf8"),
      ]);
      const [pdfPart, textPart] = await Promise.all([stat(pdfPartPath), stat(textPartPath)]);
      if (!pdfPart.isFile() || pdfPart.size <= 0 || !textPart.isFile() || textPart.size <= 0) {
        throw new Error("PDF 或 TXT 写入后为空，临时视频与 PPTX 已保留。");
      }
      await rename(pdfPartPath, active.outputPaths.pdf);
      try {
        await rename(textPartPath, active.outputPaths.text);
      } catch (error) {
        await unlink(active.outputPaths.pdf).catch(() => undefined);
        throw error;
      }
      const [pdfFile, textFile] = await Promise.all([
        stat(active.outputPaths.pdf),
        stat(active.outputPaths.text),
      ]);
      if (pdfFile.size !== pdfPart.size || textFile.size !== textPart.size) {
        await Promise.all([
          unlink(active.outputPaths.pdf).catch(() => undefined),
          unlink(active.outputPaths.text).catch(() => undefined),
        ]);
        throw new Error("PDF/TXT 最终文件校验失败，临时视频与 PPTX 已保留。");
      }
      active.snapshot.pdfPath = active.outputPaths.pdf;
      active.snapshot.textPath = active.outputPaths.text;
      active.snapshot.outputPath = active.outputPaths.pdf;
      active.snapshot.durationSeconds = finiteNumber(result.durationSeconds);
      active.snapshot.threshold = finiteNumber(result.threshold);
      active.snapshot.capturedFrames = validation.slideCount - 1;
      await unlink(temporaryPptxPath);
      log("DOCUMENT", "PDF and TXT generated and verified; temporary PPTX removed", {
        jobId: taskId,
        pdfBytes: pdfFile.size,
        textBytes: textFile.size,
        slides: validation.slideCount,
      });

      if (active.cleanupSourceAfterSuccess) {
        active.snapshot.status = "cleaning";
        this.emit(active.snapshot);
        this.finish(active);
        try {
          await this.downloads.cleanupTemporaryMedia(active.snapshot.downloadJobId);
          active.snapshot.sourceDeleted = true;
        } catch (error) {
          active.snapshot.status = "failed";
          active.snapshot.sourceDeleted = false;
          active.snapshot.error = cleanMessage(messageOf(error));
          this.emit(active.snapshot);
          log("CLEANUP", "PDF/TXT are valid but temporary media cleanup failed", {
            jobId: taskId,
            error: active.snapshot.error,
          });
          return;
        }
      } else {
        active.snapshot.sourceDeleted = false;
        this.finish(active);
      }

      active.snapshot.status = "completed";
      this.emit(active.snapshot);
    } catch (error) {
      await Promise.all([
        unlink(temporaryPptxPartPath).catch(() => undefined),
        unlink(pdfPartPath).catch(() => undefined),
        unlink(textPartPath).catch(() => undefined),
      ]);
      await this.handleFailed(senderId, taskId, messageOf(error));
    }
  }

  async handleFailed(senderId: number, taskId: string, message: string): Promise<void> {
    if (!this.isActive(taskId, senderId)) return;
    const active = this.active;
    if (!active) return;
    if (active.snapshot.status !== "cancelled") {
      active.snapshot.status = "failed";
      active.snapshot.error = cleanMessage(message);
      this.emit(active.snapshot);
      log("CONVERT", "Video conversion failed; source retained", {
        jobId: taskId,
        error: active.snapshot.error,
      });
    }
    this.finish(active);
  }

  cancel(jobId: string): ConversionJobSnapshot {
    const active = this.active;
    if (!active || active.snapshot.id !== jobId) throw new Error("转换任务不存在或已经结束。");
    active.snapshot.status = "cancelled";
    active.snapshot.error = "视频转换已取消，已下载的视频仍然保留。";
    this.emit(active.snapshot);
    active.abortController.abort();
    if (!active.window.isDestroyed()) active.window.webContents.send("conversion-worker:cancel", jobId);
    active.cleanupTimer = setTimeout(() => {
      if (this.active === active) this.finish(active);
    }, 5_000);
    return cloneSnapshot(active.snapshot);
  }

  cancelActive(): void {
    if (this.active) this.cancel(this.active.snapshot.id);
  }

  subscribe(listener: (snapshot: ConversionJobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isActive(taskId: string, senderId: number): boolean {
    return this.active?.snapshot.id === taskId && this.active.window.webContents.id === senderId;
  }

  private emit(snapshot: ConversionJobSnapshot): void {
    const cloned = cloneSnapshot(snapshot);
    this.notify(cloned);
    for (const listener of this.listeners) listener(cloneSnapshot(cloned));
  }

  private finish(active: ActiveConversion): void {
    if (this.active !== active) return;
    if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    this.mediaProtocol.revoke(active.mediaToken);
    this.active = undefined;
    if (!active.window.isDestroyed()) active.window.destroy();
  }

  private documentProgress(active: ActiveConversion, progress: DocumentExportProgress): void {
    if (this.active !== active || active.snapshot.status === "cancelled") return;
    active.snapshot.status =
      progress.stage === "recognizing-text"
        ? "recognizing-text"
        : progress.stage === "writing-text" || progress.stage === "validating"
          ? "writing-output"
          : "converting-pdf";
    active.snapshot.current = finiteNumber(progress.current);
    active.snapshot.total = finiteNumber(progress.total);
    active.snapshot.percent = boundedPercent(progress.percent);
    this.emit(active.snapshot);
  }

  private async resolveRapidOcrExecutable(): Promise<string> {
    const relative = join("document-tools", "rapidocr", "RapidOCR-json.exe");
    const candidates = [
      join(process.resourcesPath, relative),
      join(
        app.getAppPath(),
        "..",
        "..",
        "third_party",
        "runtime",
        "rapidocr",
        "win7_x64_RapidOCR-json",
        "RapidOCR-json.exe",
      ),
      join(
        process.cwd(),
        "third_party",
        "runtime",
        "rapidocr",
        "win7_x64_RapidOCR-json",
        "RapidOCR-json.exe",
      ),
      join(
        process.cwd(),
        "..",
        "..",
        "third_party",
        "runtime",
        "rapidocr",
        "win7_x64_RapidOCR-json",
        "RapidOCR-json.exe",
      ),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    throw new Error("内置 RapidOCR 引擎缺失，无法生成 TXT。");
  }

  private sofficeBinaryPaths(): string[] {
    return [join(process.resourcesPath, "document-tools", "libreoffice", "program", "soffice.exe")];
  }

  private async createOutputPaths(title: string, id: string): Promise<{ pdf: string; text: string }> {
    const directory = await this.getOutputDirectory();
    await mkdir(directory, { recursive: true });
    const stem = sanitizeWindowsFileName(title);
    const candidate = { pdf: join(directory, `${stem}.pdf`), text: join(directory, `${stem}.txt`) };
    if (!(await outputPairExists(candidate))) return candidate;
    for (let index = 2; index < 10_000; index += 1) {
      const alternative = {
        pdf: join(directory, `${stem} (${index}).pdf`),
        text: join(directory, `${stem} (${index}).txt`),
      };
      if (!(await outputPairExists(alternative))) return alternative;
    }
    const fallbackStem = `${stem}_${id.slice(0, 8)}`;
    return { pdf: join(directory, `${fallbackStem}.pdf`), text: join(directory, `${fallbackStem}.txt`) };
  }
}

async function outputPairExists(paths: { pdf: string; text: string }): Promise<boolean> {
  return (await exists(paths.pdf)) || (await exists(paths.text));
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function cloneSnapshot(snapshot: ConversionJobSnapshot): ConversionJobSnapshot {
  return { ...snapshot };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedPercent(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.min(100, parsed);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "视频转换失败，已下载的视频仍然保留。";
}

function cleanMessage(value: string): string {
  const trimmed = value
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, 500);
  return trimmed || "视频转换失败，已下载的视频仍然保留。";
}
