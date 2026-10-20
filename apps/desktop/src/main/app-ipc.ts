import { BrowserWindow, ipcMain } from "electron";

import type { UpdateAppSettings } from "../shared/app-contract";
import { AppService } from "./app-service";
import type { IpcResult } from "./xjtu-ipc";

export function registerAppIpc(_getMainWindow: () => BrowserWindow | undefined, service: AppService): void {
  ipcMain.handle("settings:get", () => safe(() => service.getSettings()));
  ipcMain.handle("settings:update", (_event, value: unknown) =>
    safe(() => service.updateSettings(parseUpdate(value))),
  );
  ipcMain.handle("settings:choose-output", () => safe(() => service.chooseOutputDirectory()));
  ipcMain.handle("library:list", () => safe(() => service.listPptx()));
  ipcMain.handle("library:open", (_event, path: unknown) => safe(() => service.openPath(parsePath(path))));
  ipcMain.handle("library:reveal", (_event, path: unknown) =>
    safe(() => service.revealPath(parsePath(path))),
  );
  ipcMain.handle("library:delete", (_event, path: unknown) =>
    safe(() => service.deletePptx(parsePath(path))),
  );
  ipcMain.handle("library:open-directory", () => safe(() => service.openOutputDirectory()));
  ipcMain.handle("temporary:cleanup-orphans", () => safe(() => service.cleanupOrphans()));
}

async function safe<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "APP_OPERATION_ERROR",
        message: error instanceof Error ? error.message : "应用操作失败。",
      },
    };
  }
}

function parseUpdate(value: unknown): UpdateAppSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("设置内容无效。");
  }
  const candidate = value as Record<string, unknown>;
  const result: UpdateAppSettings = {};
  if (candidate.outputDirectory !== undefined) {
    if (typeof candidate.outputDirectory !== "string") throw new Error("输出目录无效。");
    result.outputDirectory = candidate.outputDirectory;
  }
  if ("defaultSemesterId" in candidate) {
    if (typeof candidate.defaultSemesterId !== "string") throw new Error("默认学期无效。");
    result.defaultSemesterId = candidate.defaultSemesterId;
  }
  if (candidate.downloadConcurrency !== undefined) {
    if (candidate.downloadConcurrency !== 1 && candidate.downloadConcurrency !== 2) {
      throw new Error("下载并发只能是 1 或 2。");
    }
    result.downloadConcurrency = candidate.downloadConcurrency;
  }
  if (candidate.autoDeleteSource !== undefined) {
    if (typeof candidate.autoDeleteSource !== "boolean") throw new Error("自动清理设置无效。");
    result.autoDeleteSource = candidate.autoDeleteSource;
  }
  if (candidate.retainFailedTemporaryFiles !== undefined) {
    if (typeof candidate.retainFailedTemporaryFiles !== "boolean") {
      throw new Error("失败任务保留设置无效。");
    }
    result.retainFailedTemporaryFiles = candidate.retainFailedTemporaryFiles;
  }
  if (candidate.orphanRetentionDays !== undefined) {
    if (
      typeof candidate.orphanRetentionDays !== "number" ||
      !Number.isInteger(candidate.orphanRetentionDays)
    ) {
      throw new Error("临时文件保留天数无效。");
    }
    result.orphanRetentionDays = candidate.orphanRetentionDays;
  }
  return result;
}

function parsePath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) {
    throw new Error("文件路径无效。");
  }
  return value;
}
