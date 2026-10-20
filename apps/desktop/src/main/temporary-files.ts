import { readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TemporaryCleanupResult {
  sourceBytes: number;
  framesRemoved: boolean;
}

export interface OrphanCleanupOptions {
  olderThan: Date;
  retainFailedTemporaryFiles: boolean;
}

export interface OrphanCleanupResult {
  removedDirectories: number;
  reclaimedBytes: number;
}

export async function cleanupJobTemporaryFiles(
  jobsRoot: string,
  jobId: string,
): Promise<TemporaryCleanupResult> {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("临时任务 ID 无效。");

  const safeRoot = resolve(jobsRoot);
  const jobDirectory = resolve(safeRoot, jobId);
  if (dirname(jobDirectory) !== safeRoot) throw new Error("临时任务目录超出允许范围。");

  const sourcePath = join(jobDirectory, "source.mp4");
  const source = await stat(sourcePath).catch(() => undefined);
  if (!source?.isFile() || source.size <= 0) throw new Error("待清理的临时视频不存在或为空。");

  await unlink(sourcePath);
  await unlink(`${sourcePath}.part`).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
  await removeIntermediatePptx(jobDirectory);

  const framesDirectory = resolve(jobDirectory, "frames");
  if (dirname(framesDirectory) !== jobDirectory) throw new Error("临时帧目录超出允许范围。");
  const framesRemoved = await stat(framesDirectory)
    .then(async (entry) => {
      if (!entry.isDirectory()) throw new Error("临时帧路径不是目录。");
      await rm(framesDirectory, { recursive: true, force: false });
      return true;
    })
    .catch((error: unknown) => {
      if (isMissingFile(error)) return false;
      throw error;
    });

  return { sourceBytes: source.size, framesRemoved };
}

export async function discardJobTemporaryFiles(
  jobsRoot: string,
  jobId: string,
): Promise<TemporaryCleanupResult> {
  const jobDirectory = safeJobDirectory(jobsRoot, jobId);
  const sourcePath = join(jobDirectory, "source.mp4");
  const sourceBytes = await stat(sourcePath)
    .then((entry) => (entry.isFile() ? entry.size : 0))
    .catch(() => 0);
  await unlink(sourcePath).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
  await unlink(`${sourcePath}.part`).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
  });
  await removeIntermediatePptx(jobDirectory);
  const framesDirectory = join(jobDirectory, "frames");
  const framesRemoved = await stat(framesDirectory)
    .then(async (entry) => {
      if (!entry.isDirectory()) return false;
      await rm(framesDirectory, { recursive: true, force: false });
      return true;
    })
    .catch((error: unknown) => {
      if (isMissingFile(error)) return false;
      throw error;
    });
  return { sourceBytes, framesRemoved };
}

export async function cleanupOrphanedJobDirectories(
  jobsRoot: string,
  options: OrphanCleanupOptions,
): Promise<OrphanCleanupResult> {
  const safeRoot = resolve(jobsRoot);
  const entries = await readdir(safeRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  let removedDirectories = 0;
  let reclaimedBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    const directory = safeJobDirectory(safeRoot, entry.name);
    const directoryStat = await stat(directory);
    const metadata = await readMetadata(directory);
    const timestamp =
      typeof metadata.updatedAt === "string" ? Date.parse(metadata.updatedAt) : directoryStat.mtimeMs;
    if (!Number.isFinite(timestamp) || timestamp >= options.olderThan.getTime()) continue;
    if (
      options.retainFailedTemporaryFiles &&
      (metadata.status === "failed" || metadata.status === "cancelled")
    ) {
      continue;
    }
    reclaimedBytes += await directorySize(directory);
    await rm(directory, { recursive: true, force: false });
    removedDirectories += 1;
  }
  return { removedDirectories, reclaimedBytes };
}

function safeJobDirectory(jobsRoot: string, jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("临时任务 ID 无效。");
  const safeRoot = resolve(jobsRoot);
  const jobDirectory = resolve(safeRoot, jobId);
  if (dirname(jobDirectory) !== safeRoot) throw new Error("临时任务目录超出允许范围。");
  return jobDirectory;
}

async function readMetadata(directory: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size;
  }
  return total;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function removeIntermediatePptx(jobDirectory: string): Promise<void> {
  for (const fileName of ["intermediate.pptx", "intermediate.pptx.part"]) {
    await unlink(join(jobDirectory, fileName)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}
