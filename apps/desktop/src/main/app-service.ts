import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { app, dialog, shell } from "electron";

import type { AppSettings, CleanupSummary, PptLibraryItem, UpdateAppSettings } from "../shared/app-contract";
import { parseLibraryFileName } from "../shared/library";
import { cleanupOrphanedJobDirectories } from "./temporary-files";

export class AppService {
  private settings?: AppSettings;

  async getSettings(): Promise<AppSettings> {
    if (this.settings) return { ...this.settings };
    const defaults = this.defaultSettings();
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as Record<string, unknown>;
      this.settings = validateSettings(parsed, defaults);
    } catch {
      this.settings = defaults;
    }
    return { ...this.settings };
  }

  getCurrentSettings(): AppSettings {
    return { ...(this.settings ?? this.defaultSettings()) };
  }

  async updateSettings(update: UpdateAppSettings): Promise<AppSettings> {
    const current = await this.getSettings();
    const next = validateSettings({ ...current, ...update }, this.defaultSettings());
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.part`;
    await writeFile(temporaryPath, JSON.stringify(next, null, 2), "utf8");
    await rename(temporaryPath, this.settingsPath);
    this.settings = next;
    return { ...next };
  }

  async chooseOutputDirectory(): Promise<AppSettings | undefined> {
    const current = await this.getSettings();
    const result = await dialog.showOpenDialog({
      title: "选择 PDF/TXT 输出目录",
      defaultPath: current.outputDirectory,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return this.updateSettings({ outputDirectory: result.filePaths[0] });
  }

  async listPptx(): Promise<PptLibraryItem[]> {
    const { outputDirectory } = await this.getSettings();
    await mkdir(outputDirectory, { recursive: true });
    const entries = await readdir(outputDirectory, { withFileTypes: true });
    const fileNames = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()),
    );
    const items = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.toLowerCase().endsWith(".pdf") &&
            fileNames.has(`${entry.name.slice(0, -4).toLowerCase()}.txt`),
        )
        .map(async (entry): Promise<PptLibraryItem> => {
          const stem = entry.name.slice(0, -4);
          const pdfPath = join(outputDirectory, entry.name);
          const textPath = join(outputDirectory, `${stem}.txt`);
          const [pdfStat, textStat] = await Promise.all([stat(pdfPath), stat(textPath)]);
          const parsed = parseLibraryFileName(entry.name);
          return {
            path: pdfPath,
            fileName: stem,
            pdfPath,
            textPath,
            pdfSize: pdfStat.size,
            textSize: textStat.size,
            course: parsed.course,
            lectureDate: parsed.lectureDate,
            size: pdfStat.size + textStat.size,
            createdAt: new Date(Math.min(pdfStat.birthtimeMs, textStat.birthtimeMs)).toISOString(),
            updatedAt: new Date(Math.max(pdfStat.mtimeMs, textStat.mtimeMs)).toISOString(),
          };
        }),
    );
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async openPath(path: string): Promise<void> {
    const safePath = await this.requireLibraryFile(path);
    const error = await shell.openPath(safePath);
    if (error) throw new Error(`无法打开文件：${error}`);
  }

  async revealPath(path: string): Promise<void> {
    const safePath = await this.requireLibraryFile(path);
    shell.showItemInFolder(safePath);
  }

  async deletePptx(path: string): Promise<void> {
    const safePath = await this.requireLibraryFile(path);
    const extension = safePath.slice(-4).toLowerCase();
    const stem = safePath.slice(0, -4);
    const companion = `${stem}${extension === ".pdf" ? ".txt" : ".pdf"}`;
    await Promise.all([unlink(safePath), unlink(companion).catch(() => undefined)]);
  }

  async openOutputDirectory(): Promise<void> {
    const { outputDirectory } = await this.getSettings();
    await mkdir(outputDirectory, { recursive: true });
    const error = await shell.openPath(outputDirectory);
    if (error) throw new Error(`无法打开输出目录：${error}`);
  }

  async cleanupOrphans(): Promise<CleanupSummary> {
    const settings = await this.getSettings();
    const olderThan = new Date(Date.now() - settings.orphanRetentionDays * 24 * 60 * 60 * 1000);
    return cleanupOrphanedJobDirectories(join(app.getPath("userData"), "temp", "jobs"), {
      olderThan,
      retainFailedTemporaryFiles: settings.retainFailedTemporaryFiles,
    });
  }

  private async requireLibraryFile(path: string): Promise<string> {
    if (!isAbsolute(path) || !/\.(?:pdf|txt)$/i.test(path)) {
      throw new Error("PDF/TXT 文件路径无效。");
    }
    const { outputDirectory } = await this.getSettings();
    const root = resolve(outputDirectory);
    const candidate = resolve(path);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      throw new Error("该文件不在当前 PDF/TXT 输出目录中。");
    }
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) throw new Error("PDF/TXT 文件不存在。");
    return candidate;
  }

  private defaultSettings(): AppSettings {
    return {
      outputDirectory: join(app.getPath("documents"), "XJTU Lecture2PPT"),
      downloadConcurrency: 2,
      conversionConcurrency: 1,
      autoDeleteSource: true,
      retainFailedTemporaryFiles: true,
      orphanRetentionDays: 30,
    };
  }

  private get settingsPath(): string {
    return join(app.getPath("userData"), "settings.json");
  }
}

function validateSettings(value: Record<string, unknown>, defaults: AppSettings): AppSettings {
  const outputDirectory =
    typeof value.outputDirectory === "string" && isAbsolute(value.outputDirectory)
      ? resolve(value.outputDirectory)
      : defaults.outputDirectory;
  const defaultSemesterId =
    typeof value.defaultSemesterId === "string" && /^\d+$/.test(value.defaultSemesterId)
      ? value.defaultSemesterId
      : undefined;
  const orphanRetentionDays =
    typeof value.orphanRetentionDays === "number" &&
    Number.isInteger(value.orphanRetentionDays) &&
    value.orphanRetentionDays >= 1 &&
    value.orphanRetentionDays <= 365
      ? value.orphanRetentionDays
      : defaults.orphanRetentionDays;
  return {
    outputDirectory,
    defaultSemesterId,
    downloadConcurrency: value.downloadConcurrency === 1 ? 1 : 2,
    conversionConcurrency: 1,
    autoDeleteSource:
      typeof value.autoDeleteSource === "boolean" ? value.autoDeleteSource : defaults.autoDeleteSource,
    retainFailedTemporaryFiles:
      typeof value.retainFailedTemporaryFiles === "boolean"
        ? value.retainFailedTemporaryFiles
        : defaults.retainFailedTemporaryFiles,
    orphanRetentionDays,
  };
}
