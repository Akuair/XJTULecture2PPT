import type { ConversionOptions } from "@xjtu-lecture2ppt/video-to-ppt-core";
import { BrowserWindow, ipcMain } from "electron";

import type { StartPipelineRequest } from "../shared/pipeline-contract";
import type { ConversionService } from "./conversion-service";
import type { DownloadService } from "./download-service";
import { PipelineService } from "./pipeline-service";
import { PipelineStore } from "./pipeline-store";
import type { IpcResult } from "./xjtu-ipc";

export function registerPipelineIpc(
  getMainWindow: () => BrowserWindow | undefined,
  downloads: DownloadService,
  conversions: ConversionService,
  shouldCleanupSource: () => boolean = () => true,
): PipelineService {
  const service = new PipelineService(
    downloads,
    conversions,
    (snapshot) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send("pipeline:update", snapshot);
    },
    new PipelineStore(),
    shouldCleanupSource,
  );
  void service.initialize();
  ipcMain.handle("pipeline:list", () => safe(() => service.list()));
  ipcMain.handle("pipeline:start", (_event, request: unknown) =>
    safe(() => service.start(parseStartRequest(request))),
  );
  ipcMain.handle("pipeline:cancel", (_event, jobId: unknown) =>
    safe(() => service.cancel(parseUuid(jobId, "jobId"))),
  );
  ipcMain.handle("pipeline:retry", (_event, jobId: unknown) =>
    safe(() => service.retry(parseUuid(jobId, "jobId"))),
  );
  ipcMain.handle("pipeline:delete-temporary", (_event, jobId: unknown) =>
    safe(() => service.deleteTemporaryFiles(parseUuid(jobId, "jobId"))),
  );
  return service;
}

async function safe<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "PIPELINE_ERROR",
        message: error instanceof Error ? error.message : "生成任务失败。",
      },
    };
  }
}

function parseStartRequest(value: unknown): StartPipelineRequest {
  if (!isRecord(value)) throw new Error("生成任务请求无效。");
  return {
    courseId: parseNumericId(value.courseId, "courseId"),
    activityId: parseNumericId(value.activityId, "activityId"),
    videoId: parseNumericId(value.videoId, "videoId"),
    title: parseTitle(value.title),
    options: parseOptions(value.options),
  };
}

function parseOptions(value: unknown): ConversionOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("转换参数无效。");
  return {
    maxSlides: optionalNumber(value.maxSlides),
    threshold: optionalNumber(value.threshold),
    captureIntervalSeconds: optionalNumber(value.captureIntervalSeconds),
    startTimeSeconds: optionalNumber(value.startTimeSeconds),
    endTimeSeconds: optionalNumber(value.endTimeSeconds),
    jpegQuality: optionalNumber(value.jpegQuality),
    analysisWidth: optionalNumber(value.analysisWidth),
    seekTimeoutMs: optionalNumber(value.seekTimeoutMs),
  };
}

function parseNumericId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${field} 无效。`);
  return value;
}

function parseUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${field} 无效。`);
  }
  return value;
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\r\n\0]/.test(value)) {
    throw new Error("PPT 标题无效。");
  }
  return value.trim();
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("数值参数无效。");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
