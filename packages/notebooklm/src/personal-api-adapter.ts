import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { APIResponse, Page, Request } from "playwright-core";

import { NotebookLmError } from "./errors";
import {
  ADD_SOURCE_FILE_RPC,
  GET_NOTEBOOK_RPC,
  buildBatchExecuteRequest,
  buildGetNotebookParams,
  buildRegisterFileParams,
  containsOpaqueId,
  decodeBatchExecutePayload,
  extractFirstOpaqueId,
  type NotebookLmRpcRuntime,
  validateDynamicUploadUrl,
} from "./personal-api-protocol";
import type { NotebookInfo, NotebookLmUploadProgressListener } from "./types";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const PRODUCT_HOSTS = new Set(["notebook.google.com", "notebook.google", "notebooklm.google.com"]);

export interface NotebookLmPersonalApiAdapterOptions {
  navigationTimeoutMs?: number;
  pollIntervalMs?: number;
  uploadTimeoutMs?: number;
  verificationTimeoutMs?: number;
}

interface UploadFileDetails {
  fileName: string;
  filePath: string;
  size: number;
}

type PersonalApiPageProvider = () => Promise<Page>;

/**
 * Experimental adapter for the consumer Gemini Notebook private web protocol.
 * It never persists cookies, CSRF values, auth headers, or resumable upload URLs.
 * Every runtime credential is captured from the already authenticated Edge page
 * and kept only in this method call.
 */
export class NotebookLmPersonalApiAdapter {
  private readonly navigationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly verificationTimeoutMs: number;

  constructor(
    private readonly providePage: PersonalApiPageProvider,
    options: NotebookLmPersonalApiAdapterOptions = {},
  ) {
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 3 * 60_000;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 90_000;
  }

  async uploadFile(
    notebook: NotebookInfo,
    filePath: string,
    onProgress?: NotebookLmUploadProgressListener,
  ): Promise<void> {
    await this.uploadFiles(notebook, [filePath], onProgress);
  }

  async uploadFiles(
    notebook: NotebookInfo,
    filePaths: string[],
    onProgress?: NotebookLmUploadProgressListener,
  ): Promise<void> {
    if (filePaths.length === 0) {
      throw new NotebookLmError("NOTEBOOKLM_FILE_NOT_FOUND", "请至少选择一个 PPTX 文件。");
    }
    const notebookUrl = validateNotebook(notebook);
    const files = await Promise.all(filePaths.map((filePath) => validatePptxFile(filePath)));
    const page = await this.providePage();
    const runtime = await captureRuntime(page, notebookUrl, this.navigationTimeoutMs);

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) continue;
      const progress = (
        stage: Parameters<NotebookLmUploadProgressListener>[0]["stage"],
        message: string,
      ): void =>
        onProgress?.({
          currentFile: index + 1,
          fileName: file.fileName,
          message,
          stage,
          totalFiles: files.length,
        });
      await this.uploadOne(page, runtime, notebook, file, progress);
    }
  }

  private async uploadOne(
    page: Page,
    runtime: NotebookLmRpcRuntime,
    notebook: NotebookInfo,
    file: UploadFileDetails,
    progress: (stage: Parameters<NotebookLmUploadProgressListener>[0]["stage"], message: string) => void,
  ): Promise<void> {
    // Read only the current PPTX. Batch concurrency is deliberately fixed at one.
    const bytes = await readFile(file.filePath);
    progress("registering-source", `正在注册来源：${file.fileName}`);
    let sourceId: string | undefined;
    try {
      const registerPayload = await callRpc(
        page,
        runtime,
        ADD_SOURCE_FILE_RPC,
        buildRegisterFileParams(file.fileName, notebook.id),
        notebook.id,
        this.uploadTimeoutMs,
      );
      sourceId = extractFirstOpaqueId(registerPayload);
      if (!sourceId) throw new Error("Source ID was not present in the registration response");

      progress("starting-upload", `正在建立上传会话：${file.fileName}`);
      const uploadUrl = await startUpload(page, runtime, notebook, sourceId, file, this.uploadTimeoutMs);

      progress("uploading", `正在上传：${file.fileName}`);
      await finalizeUpload(page, runtime, notebook, uploadUrl, bytes, this.uploadTimeoutMs);

      progress("verifying-source", `正在确认来源：${file.fileName}`);
      await waitForSource(
        page,
        runtime,
        notebook.id,
        sourceId,
        this.verificationTimeoutMs,
        this.pollIntervalMs,
      );
      progress("completed", `上传完成：${file.fileName}`);
    } catch (error) {
      if (sourceId) {
        throw new NotebookLmError(
          "NOTEBOOKLM_PARTIAL_SOURCE",
          `“${file.fileName}”已在 Notebook 中注册来源，但文件上传或确认失败。请在 Notebook 中检查该来源后再决定是否重试。`,
          { cause: error },
        );
      }
      if (error instanceof NotebookLmError) throw error;
      throw new NotebookLmError(
        "NOTEBOOKLM_PRIVATE_API_CHANGED",
        "Gemini Notebook 私有上传协议可能已经变化。未开始上传文件，请切换浏览器兼容模式或重新运行 Inspector。",
        { cause: error },
      );
    }
  }
}

async function captureRuntime(
  page: Page,
  notebookUrl: string,
  timeoutMs: number,
): Promise<NotebookLmRpcRuntime> {
  const runtimeRequest = page.waitForRequest(isRuntimeRequest, { timeout: timeoutMs });
  await page.goto(notebookUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const request = await runtimeRequest;
  const url = new URL(request.url());
  const form = new URLSearchParams(request.postData() ?? "");
  const at = form.get("at");
  const headers = await request.allHeaders();
  const authUser = headers["x-goog-authuser"] ?? (await readAuthUserFromPage(page));
  const missing = [
    !at && "at",
    !authUser && "authuser",
    !url.searchParams.get("bl") && "bl",
    !url.searchParams.get("f.sid") && "f.sid",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new NotebookLmError(
      "NOTEBOOKLM_PRIVATE_API_CHANGED",
      `无法从当前已登录页面获取短期上传运行参数：${missing.join("、")}。`,
    );
  }
  return { at: at!, authUser: authUser!, templateUrl: url.toString() };
}

async function readAuthUserFromPage(page: Page): Promise<string | undefined> {
  const value = await page.evaluate(() => {
    const current = new URL(window.location.href).searchParams.get("authuser");
    if (current) return current;
    for (const element of document.querySelectorAll("[data-authuser]")) {
      const candidate = element.getAttribute("data-authuser");
      if (candidate) return candidate;
    }
    return undefined;
  });
  return typeof value === "string" && /^\d{1,3}$/.test(value) ? value : undefined;
}

function isRuntimeRequest(request: Request): boolean {
  try {
    const url = new URL(request.url());
    return (
      request.method() === "POST" &&
      PRODUCT_HOSTS.has(url.hostname) &&
      url.pathname === "/_/LabsTailwindUi/data/batchexecute" &&
      new URLSearchParams(request.postData() ?? "").has("at")
    );
  } catch {
    return false;
  }
}

async function callRpc(
  page: Page,
  runtime: NotebookLmRpcRuntime,
  rpcId: string,
  params: unknown[],
  notebookId: string,
  timeoutMs: number,
): Promise<unknown> {
  const request = buildBatchExecuteRequest(runtime, rpcId, params, notebookId);
  const origin = new URL(request.url).origin;
  const response = await page.context().request.post(request.url, {
    data: request.body,
    failOnStatusCode: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin,
      referer: `${origin}/notebook/${notebookId}`,
      "x-goog-authuser": runtime.authUser,
    },
    timeout: timeoutMs,
  });
  await requireSuccess(response);
  return decodeBatchExecutePayload(await response.text(), rpcId);
}

async function startUpload(
  page: Page,
  runtime: NotebookLmRpcRuntime,
  notebook: NotebookInfo,
  sourceId: string,
  file: UploadFileDetails,
  timeoutMs: number,
): Promise<string> {
  const origin = new URL(runtime.templateUrl).origin;
  const response = await page
    .context()
    .request.post(`${origin}/upload/_/?authuser=${encodeURIComponent(runtime.authUser)}`, {
      data: JSON.stringify({
        PROJECT_ID: notebook.id,
        SOURCE_NAME: file.fileName,
        SOURCE_ID: sourceId,
      }),
      failOnStatusCode: false,
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        origin,
        referer: notebook.url ?? `${origin}/`,
        "x-goog-authuser": runtime.authUser,
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(file.size),
        "x-goog-upload-protocol": "resumable",
      },
      timeout: timeoutMs,
    });
  await requireSuccess(response);
  if (response.headers()["x-goog-upload-status"] !== "active") {
    throw new Error("Notebook upload session did not become active");
  }
  return validateDynamicUploadUrl(response.headers()["x-goog-upload-url"], origin);
}

async function finalizeUpload(
  page: Page,
  runtime: NotebookLmRpcRuntime,
  notebook: NotebookInfo,
  uploadUrl: string,
  bytes: Buffer,
  timeoutMs: number,
): Promise<void> {
  const origin = new URL(runtime.templateUrl).origin;
  const response = await page.context().request.post(uploadUrl, {
    data: bytes,
    failOnStatusCode: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      origin,
      referer: notebook.url ?? `${origin}/`,
      "x-goog-authuser": runtime.authUser,
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    timeout: timeoutMs,
  });
  await requireSuccess(response);
  if (response.headers()["x-goog-upload-status"] !== "final") {
    throw new Error("Notebook upload session did not reach final status");
  }
}

async function waitForSource(
  page: Page,
  runtime: NotebookLmRpcRuntime,
  notebookId: string,
  sourceId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notebook = await callRpc(
      page,
      runtime,
      GET_NOTEBOOK_RPC,
      buildGetNotebookParams(notebookId),
      notebookId,
      Math.min(timeoutMs, 30_000),
    );
    if (containsOpaqueId(notebook, sourceId)) return;
    await delay(intervalMs);
  }
  throw new NotebookLmError("NOTEBOOKLM_UPLOAD_TIMEOUT", "文件已完成传输，但等待 Notebook 确认来源超时。");
}

async function requireSuccess(response: APIResponse): Promise<void> {
  if (response.status() === 401 || response.status() === 403) {
    throw new NotebookLmError("NOTEBOOKLM_AUTH_REQUIRED", "Gemini Notebook 登录已过期，请重新登录。");
  }
  if (!response.ok()) throw new Error(`Notebook request failed with HTTP ${response.status()}`);
}

function validateNotebook(notebook: NotebookInfo): string {
  if (!notebook.url) {
    throw new NotebookLmError("NOTEBOOKLM_INVALID_NOTEBOOK", "Notebook 缺少真实 URL。");
  }
  const url = new URL(notebook.url);
  const match = /^\/notebook\/([^/?#]+)\/?$/.exec(url.pathname);
  if (!PRODUCT_HOSTS.has(url.hostname) || match?.[1] !== notebook.id) {
    throw new NotebookLmError("NOTEBOOKLM_INVALID_NOTEBOOK", "Notebook ID 与真实 URL 不匹配。");
  }
  return url.toString();
}

async function validatePptxFile(filePath: string): Promise<UploadFileDetails> {
  if (extname(filePath).toLowerCase() !== ".pptx") {
    throw new NotebookLmError("NOTEBOOKLM_UNSUPPORTED_FILE", "只能上传 .pptx 文件。");
  }
  const details = await stat(filePath).catch((error: unknown) => {
    throw new NotebookLmError("NOTEBOOKLM_FILE_NOT_FOUND", "未找到 PPTX 文件。", {
      cause: error,
    });
  });
  if (!details.isFile() || details.size <= 0) {
    throw new NotebookLmError("NOTEBOOKLM_FILE_NOT_FOUND", "PPTX 文件为空或不存在。");
  }
  if (details.size > MAX_FILE_BYTES) {
    throw new NotebookLmError(
      "NOTEBOOKLM_UNSUPPORTED_FILE",
      "Gemini Notebook 个人版单个上传文件不能超过 200 MB。",
    );
  }
  return { fileName: basename(filePath), filePath, size: details.size };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
