import type { Lecture } from "@xjtu-lecture2ppt/xjtu-client";
import { BrowserWindow, ipcMain } from "electron";

import { XjtuService } from "./xjtu-service";

export interface IpcFailure {
  ok: false;
  error: { code: string; message: string };
}

export interface IpcSuccess<T> {
  ok: true;
  value: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export function registerXjtuIpc(
  getMainWindow: () => BrowserWindow | undefined,
  service: XjtuService = new XjtuService(),
): void {
  ipcMain.handle("xjtu:status", () => safe(() => service.getAuthStatus()));
  ipcMain.handle("xjtu:login", () => safe(() => service.login(getMainWindow())));
  ipcMain.handle("xjtu:logout", () => safe(() => service.logout()));
  ipcMain.handle("xjtu:semesters", () => safe(() => service.getSemesters()));
  ipcMain.handle("xjtu:courses", (_event, semesterIds?: unknown) =>
    safe(() => service.getCourses(parseIds(semesterIds, "semesterIds"))),
  );
  ipcMain.handle("xjtu:lectures", (_event, courseId: unknown) =>
    safe(() => service.getLectures(parseId(courseId, "courseId"))),
  );
  ipcMain.handle("xjtu:lecture", (_event, courseId: unknown, activityId: unknown) =>
    safe(async () =>
      stripVideoUrls(
        await service.getLecture(parseId(courseId, "courseId"), parseId(activityId, "activityId")),
      ),
    ),
  );
}

async function safe<T>(operation: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      ok: false,
      error: {
        code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN",
        message: typeof candidate.message === "string" ? candidate.message : "操作失败。",
      },
    };
  }
}

function parseId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${field} 无效。`);
  return value;
}

function parseIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} 无效。`);
  return value.map((item) => parseId(item, field));
}

function stripVideoUrls(lecture: Lecture): Lecture {
  return {
    ...lecture,
    videos: lecture.videos.map((video) => ({ ...video, url: undefined })),
  };
}
