import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import type { OcrResponse, OcrTextBlock } from "./types";

/**
 * TypeScript port of Umi-OCR's MIT-licensed Rapid_pipe adapter.
 * It preserves the upstream stdin/stdout JSON-lines protocol but sends image
 * bytes as Base64 so Chinese Windows user-profile paths are never passed to
 * the legacy native executable.
 *
 * Upstream: https://github.com/hiroi-sora/Umi-OCR_plugins/blob/main/win7_x64_RapidOCR-json/rapidocr.py
 */

export interface RapidOcrEngineOptions {
  executablePath: string;
  initializationTimeoutMs?: number;
  pageTimeoutMs?: number;
  numberOfThreads?: number;
  maximumImageSideLength?: number;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_TIMEOUT_MS = 60_000;

export class RapidOcrEngine {
  private child?: ChildProcessWithoutNullStreams;
  private output?: AsyncLineReader;
  private stderr = "";

  constructor(private readonly options: RapidOcrEngineOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    if (this.child) return;
    throwIfAborted(signal);
    const child = spawn(this.options.executablePath, buildRapidOcrArguments(this.options), {
      cwd: directoryName(this.options.executablePath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.output = new AsyncLineReader(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2_000);
    });
    try {
      while (true) {
        const line = await this.output.next(
          this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
          signal,
        );
        if (line.includes("OCR init completed.")) return;
      }
    } catch (error) {
      this.stop();
      throw new Error(`RapidOCR 初始化失败：${messageOf(error)}${this.stderr ? `；${this.stderr}` : ""}`);
    }
  }

  async recognize(image: Uint8Array, signal?: AbortSignal): Promise<OcrResponse> {
    await this.start(signal);
    throwIfAborted(signal);
    const child = this.child;
    const output = this.output;
    if (!child || !output || child.exitCode !== null) throw new Error("RapidOCR 进程未运行。");
    const command = `${JSON.stringify({ image_base64: Buffer.from(image).toString("base64") })}\n`;
    await writeCommand(child, command, signal);
    while (true) {
      const line = await output.next(this.options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS, signal);
      const response = parseOcrResponse(line);
      if (response) return response;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.output?.close();
    this.output = undefined;
    if (child && child.exitCode === null) child.kill();
  }
}

export function buildRapidOcrArguments(options: RapidOcrEngineOptions): string[] {
  return [
    "--ensureAscii=1",
    "--models=models",
    "--det=ch_PP-OCRv3_det_infer.onnx",
    "--cls=ch_ppocr_mobile_v2.0_cls_infer.onnx",
    "--rec=rec_ch_PP-OCRv4_infer.onnx",
    "--keys=dict_chinese.txt",
    "--doAngle=0",
    "--mostAngle=0",
    `--maxSideLen=${positiveInteger(options.maximumImageSideLength, 2048)}`,
    `--numThread=${positiveInteger(options.numberOfThreads, 4)}`,
  ];
}

export function parseOcrResponse(line: string): OcrResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.code)) return undefined;
  if (record.code === 100) {
    if (!Array.isArray(record.data)) return undefined;
    return { code: 100, data: record.data.map(parseTextBlock) };
  }
  return { code: record.code as number, data: typeof record.data === "string" ? record.data : "未知错误" };
}

function parseTextBlock(value: unknown): OcrTextBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RapidOCR 返回了无效文字块。");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || typeof record.score !== "number" || !Array.isArray(record.box)) {
    throw new Error("RapidOCR 返回了无效文字块字段。");
  }
  const points = record.box.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw new Error("RapidOCR 返回了无效文字坐标。");
    }
    return [Number(point[0]), Number(point[1])] as [number, number];
  });
  if (points.length !== 4) throw new Error("RapidOCR 返回的文字坐标数量无效。");
  return {
    text: record.text,
    score: record.score,
    box: points as OcrTextBlock["box"],
  };
}

class AsyncLineReader {
  private readonly lines: string[] = [];
  private readonly waiters: Array<{ resolve(line: string): void; reject(error: Error): void }> = [];
  private readonly reader: ReadLineInterface;
  private failure?: Error;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.push(line));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) =>
      this.fail(new Error(`RapidOCR 进程已退出（code=${String(code)}, signal=${String(signal)}）。`)),
    );
  }

  next(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const waiter = {
        resolve: (line: string): void => finish(() => resolve(line)),
        reject: (error: Error): void => finish(() => reject(error)),
      };
      const remove = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        remove();
        operation();
      };
      const onAbort = (): void => waiter.reject(abortError());
      const timer = setTimeout(() => waiter.reject(new Error("等待 RapidOCR 返回结果超时。")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.reader.close();
    this.fail(new Error("RapidOCR 输出已关闭。"));
  }

  private push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.lines.push(line);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function writeCommand(
  child: ChildProcessWithoutNullStreams,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => finish(() => reject(abortError()));
    const finish = (operation: () => void): void => {
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.write(command, "utf8", (error) => finish(() => (error ? reject(error) : resolve())));
  });
}

function directoryName(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "") || ".";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("文档导出已取消。");
  error.name = "AbortError";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
