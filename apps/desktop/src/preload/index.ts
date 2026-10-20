import type { Course, Lecture, Semester } from "@xjtu-lecture2ppt/xjtu-client";
import { contextBridge, ipcRenderer } from "electron";

import type { AppSettings, CleanupSummary, PptLibraryItem, UpdateAppSettings } from "../shared/app-contract";
import type { DownloadJobSnapshot, StartDownloadRequest } from "../shared/download-contract";
import type { ConversionJobSnapshot, StartConversionRequest } from "../shared/conversion-contract";
import type { PipelineJobSnapshot, StartPipelineRequest } from "../shared/pipeline-contract";

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface XjtuAuthStatus {
  authenticated: boolean;
}

export interface DesktopBridge {
  platform: NodeJS.Platform;
  versions: { electron: string; chrome: string; node: string };
  xjtu: {
    getStatus(): Promise<IpcResult<XjtuAuthStatus>>;
    login(): Promise<IpcResult<XjtuAuthStatus>>;
    logout(): Promise<IpcResult<void>>;
    getSemesters(): Promise<IpcResult<Semester[]>>;
    getCourses(semesterIds?: string[]): Promise<IpcResult<Course[]>>;
    getLectures(courseId: string): Promise<IpcResult<Lecture[]>>;
    getLecture(courseId: string, activityId: string): Promise<IpcResult<Lecture>>;
  };
  downloads: {
    list(): Promise<IpcResult<DownloadJobSnapshot[]>>;
    start(request: StartDownloadRequest): Promise<IpcResult<DownloadJobSnapshot>>;
    retry(jobId: string): Promise<IpcResult<DownloadJobSnapshot>>;
    cancel(jobId: string): Promise<IpcResult<DownloadJobSnapshot>>;
    onUpdate(callback: (snapshot: DownloadJobSnapshot) => void): void;
    clearUpdateListener(): void;
  };
  conversions: {
    start(request: StartConversionRequest): Promise<IpcResult<ConversionJobSnapshot>>;
    cancel(jobId: string): Promise<IpcResult<ConversionJobSnapshot>>;
    onUpdate(callback: (snapshot: ConversionJobSnapshot) => void): void;
    clearUpdateListener(): void;
  };
  pipeline: {
    list(): Promise<IpcResult<PipelineJobSnapshot[]>>;
    start(request: StartPipelineRequest): Promise<IpcResult<PipelineJobSnapshot>>;
    cancel(jobId: string): Promise<IpcResult<PipelineJobSnapshot>>;
    retry(jobId: string): Promise<IpcResult<PipelineJobSnapshot>>;
    deleteTemporaryFiles(jobId: string): Promise<IpcResult<PipelineJobSnapshot>>;
    onUpdate(callback: (snapshot: PipelineJobSnapshot) => void): void;
    clearUpdateListener(): void;
  };
  settings: {
    get(): Promise<IpcResult<AppSettings>>;
    update(value: UpdateAppSettings): Promise<IpcResult<AppSettings>>;
    chooseOutputDirectory(): Promise<IpcResult<AppSettings | undefined>>;
    cleanupOrphans(): Promise<IpcResult<CleanupSummary>>;
  };
  library: {
    list(): Promise<IpcResult<PptLibraryItem[]>>;
    open(path: string): Promise<IpcResult<void>>;
    reveal(path: string): Promise<IpcResult<void>>;
    delete(path: string): Promise<IpcResult<void>>;
    openDirectory(): Promise<IpcResult<void>>;
  };
}

let downloadUpdateListener:
  ((_event: Electron.IpcRendererEvent, snapshot: DownloadJobSnapshot) => void) | undefined;
let conversionUpdateListener:
  ((_event: Electron.IpcRendererEvent, snapshot: ConversionJobSnapshot) => void) | undefined;
let pipelineUpdateListener:
  ((_event: Electron.IpcRendererEvent, snapshot: PipelineJobSnapshot) => void) | undefined;

const bridge: DesktopBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  xjtu: {
    getStatus: () => ipcRenderer.invoke("xjtu:status") as Promise<IpcResult<XjtuAuthStatus>>,
    login: () => ipcRenderer.invoke("xjtu:login") as Promise<IpcResult<XjtuAuthStatus>>,
    logout: () => ipcRenderer.invoke("xjtu:logout") as Promise<IpcResult<void>>,
    getSemesters: () => ipcRenderer.invoke("xjtu:semesters") as Promise<IpcResult<Semester[]>>,
    getCourses: (semesterIds) =>
      ipcRenderer.invoke("xjtu:courses", semesterIds) as Promise<IpcResult<Course[]>>,
    getLectures: (courseId) => ipcRenderer.invoke("xjtu:lectures", courseId) as Promise<IpcResult<Lecture[]>>,
    getLecture: (courseId, activityId) =>
      ipcRenderer.invoke("xjtu:lecture", courseId, activityId) as Promise<IpcResult<Lecture>>,
  },
  downloads: {
    list: () => ipcRenderer.invoke("download:list") as Promise<IpcResult<DownloadJobSnapshot[]>>,
    start: (request) =>
      ipcRenderer.invoke("download:start", request) as Promise<IpcResult<DownloadJobSnapshot>>,
    retry: (jobId) => ipcRenderer.invoke("download:retry", jobId) as Promise<IpcResult<DownloadJobSnapshot>>,
    cancel: (jobId) =>
      ipcRenderer.invoke("download:cancel", jobId) as Promise<IpcResult<DownloadJobSnapshot>>,
    onUpdate: (callback) => {
      if (downloadUpdateListener) ipcRenderer.removeListener("download:update", downloadUpdateListener);
      downloadUpdateListener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on("download:update", downloadUpdateListener);
    },
    clearUpdateListener: () => {
      if (downloadUpdateListener) ipcRenderer.removeListener("download:update", downloadUpdateListener);
      downloadUpdateListener = undefined;
    },
  },
  conversions: {
    start: (request) =>
      ipcRenderer.invoke("conversion:start", request) as Promise<IpcResult<ConversionJobSnapshot>>,
    cancel: (jobId) =>
      ipcRenderer.invoke("conversion:cancel", jobId) as Promise<IpcResult<ConversionJobSnapshot>>,
    onUpdate: (callback) => {
      if (conversionUpdateListener) {
        ipcRenderer.removeListener("conversion:update", conversionUpdateListener);
      }
      conversionUpdateListener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on("conversion:update", conversionUpdateListener);
    },
    clearUpdateListener: () => {
      if (conversionUpdateListener) {
        ipcRenderer.removeListener("conversion:update", conversionUpdateListener);
      }
      conversionUpdateListener = undefined;
    },
  },
  pipeline: {
    list: () => ipcRenderer.invoke("pipeline:list") as Promise<IpcResult<PipelineJobSnapshot[]>>,
    start: (request) =>
      ipcRenderer.invoke("pipeline:start", request) as Promise<IpcResult<PipelineJobSnapshot>>,
    cancel: (jobId) =>
      ipcRenderer.invoke("pipeline:cancel", jobId) as Promise<IpcResult<PipelineJobSnapshot>>,
    retry: (jobId) => ipcRenderer.invoke("pipeline:retry", jobId) as Promise<IpcResult<PipelineJobSnapshot>>,
    deleteTemporaryFiles: (jobId) =>
      ipcRenderer.invoke("pipeline:delete-temporary", jobId) as Promise<IpcResult<PipelineJobSnapshot>>,
    onUpdate: (callback) => {
      if (pipelineUpdateListener) ipcRenderer.removeListener("pipeline:update", pipelineUpdateListener);
      pipelineUpdateListener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on("pipeline:update", pipelineUpdateListener);
    },
    clearUpdateListener: () => {
      if (pipelineUpdateListener) ipcRenderer.removeListener("pipeline:update", pipelineUpdateListener);
      pipelineUpdateListener = undefined;
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<IpcResult<AppSettings>>,
    update: (value) => ipcRenderer.invoke("settings:update", value) as Promise<IpcResult<AppSettings>>,
    chooseOutputDirectory: () =>
      ipcRenderer.invoke("settings:choose-output") as Promise<IpcResult<AppSettings | undefined>>,
    cleanupOrphans: () =>
      ipcRenderer.invoke("temporary:cleanup-orphans") as Promise<IpcResult<CleanupSummary>>,
  },
  library: {
    list: () => ipcRenderer.invoke("library:list") as Promise<IpcResult<PptLibraryItem[]>>,
    open: (path) => ipcRenderer.invoke("library:open", path) as Promise<IpcResult<void>>,
    reveal: (path) => ipcRenderer.invoke("library:reveal", path) as Promise<IpcResult<void>>,
    delete: (path) => ipcRenderer.invoke("library:delete", path) as Promise<IpcResult<void>>,
    openDirectory: () => ipcRenderer.invoke("library:open-directory") as Promise<IpcResult<void>>,
  },
};

contextBridge.exposeInMainWorld("lecture2ppt", bridge);
