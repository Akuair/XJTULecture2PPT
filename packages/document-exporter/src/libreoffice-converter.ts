import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Adapted from the MIT-licensed libreoffice-convert package. It retains the
 * isolated LibreOffice profile, headless --convert-to invocation and delayed
 * output read, but accepts an existing workspace so the caller controls all
 * temporary files.
 *
 * Upstream: https://github.com/elwerene/libreoffice-convert
 */

export interface LibreOfficeConversionOptions {
  workingDirectory: string;
  sofficeBinaryPaths?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function convertPptxToPdf(
  pptx: Uint8Array,
  options: LibreOfficeConversionOptions,
): Promise<Uint8Array> {
  await mkdir(options.workingDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(join(options.workingDirectory, "libreoffice-"));
  const outputDirectory = join(temporaryRoot, "output");
  const profileDirectory = join(temporaryRoot, "profile");
  const sourcePath = join(temporaryRoot, "source.pptx");
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(profileDirectory, { recursive: true });
  try {
    await writeFile(sourcePath, pptx);
    const executable = await resolveSofficeBinary(options.sofficeBinaryPaths ?? []);
    const arguments_ = [
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      outputDirectory,
      sourcePath,
    ];
    await execute(executable, arguments_, options.timeoutMs ?? 180_000, options.signal);
    const outputPath = join(outputDirectory, `${basename(sourcePath, extname(sourcePath))}.pdf`);
    const pdf = await readWithRetry(outputPath);
    validatePdf(pdf);
    return pdf;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function resolveSofficeBinary(candidates: string[]): Promise<string> {
  const defaults =
    process.platform === "win32"
      ? [
          process.env.LIBRE_OFFICE_EXE,
          join(process.env.PROGRAMFILES ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
          join(
            process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
            "LibreOffice",
            "program",
            "soffice.exe",
          ),
        ]
      : ["/usr/bin/libreoffice", "/usr/bin/soffice", "/opt/libreoffice/program/soffice"];
  for (const candidate of [...candidates, ...defaults].filter((value): value is string => Boolean(value))) {
    if (!isAbsolute(candidate)) continue;
    if (await canExecute(candidate)) return candidate;
  }
  const fromPath = await findOnPath(process.platform === "win32" ? "soffice.exe" : "soffice");
  if (fromPath) return fromPath;
  throw new Error("未找到 LibreOffice 转换引擎，无法生成 PDF。请安装 LibreOffice 或配置内置引擎。");
}

export function validatePdf(pdf: Uint8Array): void {
  if (pdf.byteLength < 8) throw new Error("LibreOffice 返回了空 PDF。");
  const header = Buffer.from(pdf.subarray(0, 5)).toString("ascii");
  const tail = Buffer.from(pdf.subarray(Math.max(0, pdf.byteLength - 1_024))).toString("ascii");
  if (header !== "%PDF-" || !tail.includes("%%EOF")) throw new Error("LibreOffice 返回的文件不是有效 PDF。");
}

async function execute(
  executable: string,
  arguments_: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      { timeout: timeoutMs, windowsHide: true, signal, maxBuffer: 2 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`LibreOffice 转换失败：${error.message}`));
        else if (stderr && stderr.toLowerCase().includes("error")) {
          reject(new Error(`LibreOffice 转换失败：${stderr.trim()}`));
        } else resolve();
      },
    );
  });
}

async function readWithRetry(path: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await readFile(path);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

async function canExecute(path: string): Promise<boolean> {
  return access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

async function findOnPath(name: string): Promise<string | undefined> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(command, [name], { windowsHide: true }, (error, stdout) => {
      if (error) resolve(undefined);
      else
        resolve(
          stdout
            .split(/\r?\n/)
            .map((value) => value.trim())
            .find(Boolean),
        );
    });
  });
}
