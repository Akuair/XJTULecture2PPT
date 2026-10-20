import { BrowserWindow, ipcMain } from "electron";

import type { DownloadJobSnapshot, StartDownloadRequest } from "../shared/download-contract";
import { DownloadService } from "./download-service";
import type { IpcResult } from "./xjtu-ipc";
import { XjtuService } from "./xjtu-service";

export function registerDownloadIpc(
  getMainWindow: () => BrowserWindow | undefined,
  xjtu: XjtuService,
  getMaxConcurrentDownloads: () => number = () => 2,
): DownloadService {
  const service = new DownloadService(
    xjtu,
    (snapshot) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send("download:update", snapshot);
    },
    getMaxConcurrentDownloads,
  );

  ipcMain.handle("download:start", (_event, value: unknown) =>
    safe(() => Promise.resolve(service.start(parseStartRequest(value)))),
  );
  ipcMain.handle("download:list", () => safe(() => service.list()));
  ipcMain.handle("download:retry", (_event, jobId: unknown) =>
    safe(() => Promise.resolve(service.retry(parseJobId(jobId)))),
  );
  ipcMain.handle("download:cancel", (_event, jobId: unknown) =>
    safe(() => Promise.resolve(service.cancel(parseJobId(jobId)))),
  );
  return service;
}

async function safe<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        code: typeof candidate.code === "string" ? candidate.code : "INVALID_REQUEST",
        message: typeof candidate.message === "string" ? candidate.message : "下载操作失败。",
      },
    };
  }
}

function parseStartRequest(value: unknown): StartDownloadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("下载请求无效。");
  const candidate = value as Record<string, unknown>;
  return {
    courseId: parseNumericId(candidate.courseId, "courseId"),
    activityId: parseNumericId(candidate.activityId, "activityId"),
    videoId: parseNumericId(candidate.videoId, "videoId"),
  };
}

function parseNumericId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${field} 无效。`);
  return value;
}

function parseJobId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("jobId 无效。");
  }
  return value;
}

export type DownloadIpcResult = IpcResult<DownloadJobSnapshot>;
