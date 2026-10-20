import { access, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { DownloadError } from "./errors";
import type {
  DownloadProgress,
  DownloadProgressHandler,
  DownloadResult,
  DownloadSource,
  StreamingDownloadRequest,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 750;

export async function downloadToFile(
  request: StreamingDownloadRequest,
  onProgress?: DownloadProgressHandler,
): Promise<DownloadResult> {
  const timeoutMs = positiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxRetries = nonNegativeInteger(request.maxRetries, DEFAULT_MAX_RETRIES);
  const retryDelayMs = nonNegativeInteger(request.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const resume = request.resume ?? true;
  const partPath = `${request.destinationPath}.part`;

  throwIfCancelled(request.signal);
  await assertDestinationAvailable(request.destinationPath);
  await mkdir(dirname(request.destinationPath), { recursive: true });
  if (!resume) await rm(partPath, { force: true });

  emit(onProgress, progress("preparing", 1, 0, undefined, false));
  let lastError: DownloadError | undefined;

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    const attempt = retry + 1;
    throwIfCancelled(request.signal);
    try {
      emit(onProgress, progress("resolving", attempt, await fileSize(partPath), undefined, false));
      const source = await request.resolveSource(attempt);
      assertSupportedSource(source);
      return await downloadAttempt({
        request,
        source,
        partPath,
        attempt,
        timeoutMs,
        resume,
        onProgress,
      });
    } catch (error) {
      const normalized = normalizeError(error, request.signal);
      if (!normalized.retryable || retry === maxRetries) throw normalized;
      lastError = normalized;
      const downloadedBytes = await fileSize(partPath);
      emit(onProgress, progress("retrying", attempt, downloadedBytes, undefined, downloadedBytes > 0));
      await cancellableDelay(retryDelayMs * 2 ** retry, request.signal);
    }
  }

  throw lastError ?? new DownloadError("HTTP_ERROR", "视频下载失败。", { retryable: false });
}

interface AttemptOptions {
  request: StreamingDownloadRequest;
  source: DownloadSource;
  partPath: string;
  attempt: number;
  timeoutMs: number;
  resume: boolean;
  onProgress?: DownloadProgressHandler;
}

async function downloadAttempt(options: AttemptOptions): Promise<DownloadResult> {
  let offset = options.resume ? await fileSize(options.partPath) : 0;
  const headers = new Headers(options.source.headers);
  headers.set("Range", `bytes=${offset}-`);

  const attemptAbort = new InactivityAbort(options.timeoutMs, options.request.signal);
  let response: Response;
  try {
    response = await options.request.fetch(options.source.url, {
      method: "GET",
      headers,
      credentials: "include",
      redirect: "follow",
      signal: attemptAbort.signal,
    });
    attemptAbort.reset();
  } catch (error) {
    attemptAbort.dispose();
    throw attemptAbort.toError(error);
  }

  try {
    if (response.status === 416) {
      return await completeAlreadyDownloadedRange(response, options, offset);
    }
    assertSuccessfulResponse(response);
    assertSupportedResponse(response, options.source);

    const contentRange = parseContentRange(response.headers.get("content-range"));
    let resumed = offset > 0 && response.status === 206;
    if (response.status === 206 && contentRange?.start !== offset) {
      await rm(options.partPath, { force: true });
      throw new DownloadError("INVALID_MEDIA_RESPONSE", "视频服务器返回了无效的断点范围。", {
        retryable: true,
      });
    }
    if (offset > 0 && response.status === 200) {
      offset = 0;
      resumed = false;
    }

    const responseLength = parsePositiveHeader(response.headers.get("content-length"));
    const totalBytes =
      contentRange?.total ?? (responseLength === undefined ? undefined : offset + responseLength);
    const body = response.body;
    if (!body) {
      throw new DownloadError("INVALID_MEDIA_RESPONSE", "视频服务器没有返回媒体数据。", {
        retryable: true,
      });
    }

    const file = await openPartFile(options.partPath, resumed ? "a" : "w");
    let downloadedBytes = offset;
    let receivedBytes = 0;
    let lastProgressAt = 0;
    const reader = body.getReader();
    try {
      emit(
        options.onProgress,
        progress("downloading", options.attempt, downloadedBytes, totalBytes, resumed),
      );
      for (;;) {
        throwIfCancelled(options.request.signal);
        const { done, value } = await reader.read();
        attemptAbort.reset();
        if (done) break;
        if (!value?.byteLength) continue;
        await writeChunk(file, value);
        downloadedBytes += value.byteLength;
        receivedBytes += value.byteLength;
        const now = Date.now();
        if (now - lastProgressAt >= 100) {
          lastProgressAt = now;
          emit(
            options.onProgress,
            progress("downloading", options.attempt, downloadedBytes, totalBytes, resumed),
          );
        }
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // The request may already be aborted.
      }
      throw attemptAbort.toError(error);
    } finally {
      await file.close();
    }

    if (responseLength !== undefined && receivedBytes !== responseLength) {
      throw new DownloadError("INCOMPLETE_DOWNLOAD", "视频连接提前中断，将尝试断点续传。", {
        retryable: true,
      });
    }
    if (totalBytes !== undefined && downloadedBytes < totalBytes) {
      throw new DownloadError("INCOMPLETE_DOWNLOAD", "视频尚未下载完整，将尝试断点续传。", {
        retryable: true,
      });
    }
    if (downloadedBytes <= 0) {
      throw new DownloadError("INVALID_MEDIA_RESPONSE", "下载到的视频文件为空。", {
        retryable: true,
      });
    }

    await verifyMp4(options.partPath);
    await rename(options.partPath, options.request.destinationPath);
    emit(options.onProgress, progress("completed", options.attempt, downloadedBytes, totalBytes, resumed));
    return {
      destinationPath: options.request.destinationPath,
      downloadedBytes,
      totalBytes,
      resumed,
      attempts: options.attempt,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } finally {
    attemptAbort.dispose();
  }
}

async function completeAlreadyDownloadedRange(
  response: Response,
  options: AttemptOptions,
  offset: number,
): Promise<DownloadResult> {
  const totalBytes = parseUnsatisfiedRangeTotal(response.headers.get("content-range"));
  if (totalBytes === undefined || totalBytes <= 0 || offset !== totalBytes) {
    throw new DownloadError("INVALID_MEDIA_RESPONSE", "视频服务器拒绝了当前断点范围。", {
      retryable: false,
      status: response.status,
    });
  }
  await verifyMp4(options.partPath);
  await rename(options.partPath, options.request.destinationPath);
  emit(options.onProgress, progress("completed", options.attempt, offset, totalBytes, true));
  return {
    destinationPath: options.request.destinationPath,
    downloadedBytes: offset,
    totalBytes,
    resumed: true,
    attempts: options.attempt,
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function assertSuccessfulResponse(response: Response): void {
  if (response.status === 401) {
    throw new DownloadError("AUTH_REQUIRED", "西交登录已经过期，请重新登录。", {
      status: response.status,
    });
  }
  if (response.status === 403) {
    throw new DownloadError("FORBIDDEN", "视频链接已经过期或当前账号无权访问。", {
      retryable: true,
      status: response.status,
    });
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new DownloadError("HTTP_ERROR", `课堂视频服务器暂时不可用（HTTP ${response.status}）。`, {
      retryable: true,
      status: response.status,
    });
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new DownloadError("HTTP_ERROR", `视频请求失败（HTTP ${response.status}）。`, {
      status: response.status,
    });
  }
}

function assertSupportedSource(source: DownloadSource): void {
  if (!source.url || !/^https:\/\//i.test(source.url)) {
    throw new DownloadError("INVALID_MEDIA_RESPONSE", "视频地址无效。", { retryable: true });
  }
  if (source.streamType === "hls") {
    throw new DownloadError("UNSUPPORTED_HLS", "该视频为 HLS 流，当前 MP4 下载阶段暂不处理。", {
      retryable: false,
    });
  }
  if (source.streamType === "dash") {
    throw new DownloadError("UNSUPPORTED_DASH", "该视频为 DASH 流，当前 MP4 下载阶段暂不处理。", {
      retryable: false,
    });
  }
}

function assertSupportedResponse(response: Response, source: DownloadSource): void {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const pathname = safePathname(response.url || source.url).toLowerCase();
  if (contentType.includes("mpegurl") || pathname.endsWith(".m3u8")) {
    throw new DownloadError("UNSUPPORTED_HLS", "该视频实际返回 HLS 播放列表，已停止下载。", {
      retryable: false,
    });
  }
  if (contentType.includes("dash+xml") || pathname.endsWith(".mpd")) {
    throw new DownloadError("UNSUPPORTED_DASH", "该视频实际返回 DASH 清单，已停止下载。", {
      retryable: false,
    });
  }
  if (contentType.includes("text/html")) {
    throw new DownloadError("AUTH_REQUIRED", "视频请求跳转到了登录页面，请重新登录。", {
      retryable: false,
    });
  }
  if (contentType.includes("application/json")) {
    throw new DownloadError("INVALID_MEDIA_RESPONSE", "视频服务器返回了错误数据而不是媒体文件。", {
      retryable: true,
    });
  }
}

async function verifyMp4(path: string): Promise<void> {
  const file = await openPartFile(path, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 8 || buffer.subarray(0, bytesRead).indexOf(Buffer.from("ftyp")) < 4) {
      throw new DownloadError("INVALID_MEDIA_RESPONSE", "下载结果不是可识别的 MP4 文件。", {
        retryable: true,
      });
    }
  } finally {
    await file.close();
  }
}

async function assertDestinationAvailable(path: string): Promise<void> {
  try {
    await access(path);
    throw new DownloadError("DESTINATION_EXISTS", "目标视频文件已经存在。", { retryable: false });
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DownloadError("IO_ERROR", "无法检查视频目标文件。", { cause: error });
    }
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new DownloadError("IO_ERROR", "无法读取临时视频文件。", { cause: error });
  }
}

async function openPartFile(path: string, flags: "a" | "w" | "r") {
  try {
    return await open(path, flags);
  } catch (error) {
    throw new DownloadError("IO_ERROR", "无法打开临时视频文件。", { cause: error });
  }
}

async function writeChunk(file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array): Promise<void> {
  try {
    let written = 0;
    while (written < chunk.byteLength) {
      const result = await file.write(chunk, written, chunk.byteLength - written);
      if (result.bytesWritten <= 0) throw new Error("Zero-byte write");
      written += result.bytesWritten;
    }
  } catch (error) {
    throw new DownloadError("IO_ERROR", "写入临时视频文件失败。", { cause: error });
  }
}

class InactivityAbort {
  private readonly controller = new AbortController();
  private readonly externalSignal?: AbortSignal;
  private readonly timeoutMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private timedOut = false;
  private readonly onExternalAbort = (): void => this.controller.abort(this.externalSignal?.reason);

  constructor(timeoutMs: number, externalSignal?: AbortSignal) {
    this.timeoutMs = timeoutMs;
    this.externalSignal = externalSignal;
    if (externalSignal?.aborted) this.controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener("abort", this.onExternalAbort, { once: true });
    this.reset();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  reset(): void {
    if (this.controller.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }

  toError(error: unknown): DownloadError {
    if (this.externalSignal?.aborted) {
      return new DownloadError("CANCELLED", "视频下载已取消。", { cause: error });
    }
    if (this.timedOut) {
      return new DownloadError("TIMEOUT", "视频连接超时，将自动重试。", {
        retryable: true,
        cause: error,
      });
    }
    return normalizeError(error);
  }
}

function normalizeError(error: unknown, signal?: AbortSignal): DownloadError {
  if (error instanceof DownloadError) return error;
  if (signal?.aborted) return new DownloadError("CANCELLED", "视频下载已取消。", { cause: error });
  return new DownloadError("HTTP_ERROR", "视频连接中断，将自动重试。", {
    retryable: true,
    cause: error,
  });
}

function progress(
  stage: DownloadProgress["stage"],
  attempt: number,
  downloadedBytes: number,
  totalBytes: number | undefined,
  resumed: boolean,
): DownloadProgress {
  return {
    stage,
    attempt,
    downloadedBytes,
    totalBytes,
    percent:
      totalBytes === undefined || totalBytes <= 0
        ? undefined
        : Math.min(100, (downloadedBytes / totalBytes) * 100),
    resumed,
  };
}

function emit(handler: DownloadProgressHandler | undefined, value: DownloadProgress): void {
  try {
    handler?.(value);
  } catch {
    // A UI progress callback must never interrupt the download.
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total?: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  return { start, end, total };
}

function parseUnsatisfiedRangeTotal(value: string | null): number | undefined {
  const match = /^bytes\s+\*\/(\d+)$/i.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : undefined;
}

function parsePositiveHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadError("CANCELLED", "视频下载已取消。", { cause: signal.reason });
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DownloadError("CANCELLED", "视频下载已取消。", { cause: signal?.reason }));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
