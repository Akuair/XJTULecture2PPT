import { join } from "node:path";

import { app, BrowserWindow, protocol, shell } from "electron";

import { registerAppIpc } from "./app-ipc";
import { AppService } from "./app-service";
import { registerConversionIpc } from "./conversion-ipc";
import type { ConversionService } from "./conversion-service";
import { registerDownloadIpc } from "./download-ipc";
import type { DownloadService } from "./download-service";
import { log } from "./logger";
import { registerPipelineIpc } from "./pipeline-ipc";
import { registerXjtuIpc } from "./xjtu-ipc";
import { XjtuService } from "./xjtu-service";

let mainWindow: BrowserWindow | undefined;
let downloadService: DownloadService | undefined;
let conversionService: ConversionService | undefined;

app.setName("XJTU Lecture2PPT");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "xjtu-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "XJTU Lecture2PPT",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log("DESKTOP", "Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    log("DESKTOP", "Preload failed", { preloadPath, error: error.message });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log("DESKTOP", "Renderer process exited", details);
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) log("RENDERER", "Renderer console error", { message });
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
};

app.whenReady().then(async () => {
  app.setAppUserModelId("cn.edu.xjtu.lecture2ppt");
  const appService = new AppService();
  await appService.getSettings();
  registerAppIpc(() => mainWindow, appService);
  const xjtuService = new XjtuService();
  registerXjtuIpc(() => mainWindow, xjtuService);
  downloadService = registerDownloadIpc(
    () => mainWindow,
    xjtuService,
    () => appService.getCurrentSettings().downloadConcurrency,
  );
  conversionService = registerConversionIpc(
    () => mainWindow,
    downloadService,
    async () => (await appService.getSettings()).outputDirectory,
  );
  registerPipelineIpc(
    () => mainWindow,
    downloadService,
    conversionService,
    () => appService.getCurrentSettings().autoDeleteSource,
  );
  void appService.cleanupOrphans().then((summary) => {
    if (summary.removedDirectories > 0) {
      log("CLEANUP", "Old temporary task directories removed", summary);
    }
  });
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  conversionService?.cancelActive();
  downloadService?.cancelAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
