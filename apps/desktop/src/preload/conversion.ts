import { contextBridge, ipcRenderer } from "electron";

import type { ConversionRendererResult, ConversionRendererTask } from "../shared/conversion-contract";
import type { ConversionProgress } from "@xjtu-lecture2ppt/video-to-ppt-core";

export interface ConversionWorkerBridge {
  ready(): void;
  onTask(callback: (task: ConversionRendererTask) => void): void;
  onCancel(callback: (taskId: string) => void): void;
  progress(taskId: string, progress: ConversionProgress): void;
  complete(taskId: string, pptx: ArrayBuffer, result: ConversionRendererResult): void;
  fail(taskId: string, message: string): void;
}

const bridge: ConversionWorkerBridge = {
  ready: () => ipcRenderer.send("conversion-worker:ready"),
  onTask: (callback) => {
    ipcRenderer.once("conversion-worker:task", (_event, task: ConversionRendererTask) => callback(task));
  },
  onCancel: (callback) => {
    ipcRenderer.on("conversion-worker:cancel", (_event, taskId: string) => callback(taskId));
  },
  progress: (taskId, progress) => ipcRenderer.send("conversion-worker:progress", taskId, progress),
  complete: (taskId, pptx, result) =>
    ipcRenderer.send("conversion-worker:complete", { taskId, pptx, result }),
  fail: (taskId, message) => ipcRenderer.send("conversion-worker:failed", taskId, message),
};

contextBridge.exposeInMainWorld("conversionWorker", bridge);
