import type { ConversionOptions, ConversionProgress } from "@xjtu-lecture2ppt/video-to-ppt-core";
import { BrowserWindow, ipcMain } from "electron";

import type { ConversionRendererResult, StartConversionRequest } from "../shared/conversion-contract";
import { ConversionService } from "./conversion-service";
import { DownloadService } from "./download-service";
import type { IpcResult } from "./xjtu-ipc";

export function registerConversionIpc(
  getMainWindow: () => BrowserWindow | undefined,
  downloads: DownloadService,
  getOutputDirectory?: () => Promise<string>,
): ConversionService {
  const service = new ConversionService(
    downloads,
    (snapshot) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send("conversion:update", snapshot);
    },
    getOutputDirectory,
  );
  ipcMain.handle("conversion:start", (_event, request: unknown) =>
    safe(() => service.start(parseStartRequest(request))),
  );
  ipcMain.handle("conversion:cancel", (_event, jobId: unknown) =>
    safe(() => Promise.resolve(service.cancel(parseUuid(jobId, "jobId")))),
  );
  ipcMain.on("conversion-worker:ready", (event) => service.ready(event.sender.id));
  ipcMain.on("conversion-worker:progress", (event, taskId: unknown, progress: unknown) => {
    service.progress(event.sender.id, parseUuid(taskId, "taskId"), parseProgress(progress));
  });
  ipcMain.on("conversion-worker:complete", (event, payload: unknown) => {
    const parsed = parseCompletePayload(payload);
    void service.complete(event.sender.id, parsed.taskId, parsed.pptx, parsed.result);
  });
  ipcMain.on("conversion-worker:failed", (event, taskId: unknown, message: unknown) => {
    void service.handleFailed(
      event.sender.id,
      parseUuid(taskId, "taskId"),
      typeof message === "string" ? message : "视频转换失败。",
    );
  });
  return service;
}

async function safe<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "CONVERSION_ERROR",
        message: error instanceof Error ? error.message : "视频转换失败。",
      },
    };
  }
}

function parseStartRequest(value: unknown): StartConversionRequest {
  if (!isRecord(value)) throw new Error("转换请求无效。");
  return {
    downloadJobId: parseUuid(value.downloadJobId, "downloadJobId"),
    title: optionalTitle(value.title),
    cleanupSourceAfterSuccess: optionalBoolean(value.cleanupSourceAfterSuccess),
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

function parseProgress(value: unknown): ConversionProgress {
  if (!isRecord(value)) throw new Error("转换进度无效。");
  if (
    value.stage !== "loading" &&
    value.stage !== "analyzing" &&
    value.stage !== "extracting" &&
    value.stage !== "generating-ppt"
  ) {
    throw new Error("转换阶段无效。");
  }
  return {
    stage: value.stage,
    current: optionalNumber(value.current),
    total: optionalNumber(value.total),
    percent: optionalNumber(value.percent),
    capturedFrames: optionalNumber(value.capturedFrames),
  };
}

function parseCompletePayload(value: unknown): {
  taskId: string;
  pptx: ArrayBuffer;
  result: ConversionRendererResult;
} {
  if (!isRecord(value) || !(value.pptx instanceof ArrayBuffer) || !isRecord(value.result)) {
    throw new Error("转换结果无效。");
  }
  return {
    taskId: parseUuid(value.taskId, "taskId"),
    pptx: value.pptx,
    result: {
      durationSeconds: requiredNumber(value.result.durationSeconds),
      analyzedEndTimeSeconds: requiredNumber(value.result.analyzedEndTimeSeconds),
      threshold: requiredNumber(value.result.threshold),
      capturedFrameCount: requiredNumber(value.result.capturedFrameCount),
    },
  };
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

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 180 || /[\r\n\0]/.test(value)) {
    throw new Error("PPT 标题无效。");
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requiredNumber(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("布尔参数无效。");
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("数值参数无效。");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
