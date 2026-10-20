import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { Locator, Page } from "playwright-core";

import { NotebookLmError } from "./errors";
import type { NotebookInfo, NotebookLmAdapter, NotebookLmUploadProgressListener } from "./types";

const DEFAULT_HOME_URL = "https://notebook.google.com/";
const SUPPORTED_HOSTS = new Set(["notebook.google.com", "notebook.google", "notebooklm.google.com"]);

export interface NotebookLmBrowserAdapterOptions {
  authenticationTimeoutMs?: number;
  homeUrl?: string;
  navigationTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export type NotebookLmPageProvider = () => Promise<Page>;

export interface NotebookCardSnapshot {
  featured?: boolean;
  href: string;
  title: string;
}

export class NotebookLmBrowserAdapter implements NotebookLmAdapter {
  private readonly authenticationTimeoutMs: number;
  private readonly homeUrl: string;
  private readonly navigationTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(
    private readonly providePage: NotebookLmPageProvider,
    options: NotebookLmBrowserAdapterOptions = {},
  ) {
    this.authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5 * 60_000;
    this.homeUrl = options.homeUrl ?? DEFAULT_HOME_URL;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 3 * 60_000;
  }

  async isAuthenticated(): Promise<boolean> {
    const page = await this.providePage();
    await this.navigateHome(page);
    return await isAuthenticatedPage(page);
  }

  async login(): Promise<void> {
    const page = await this.providePage();
    await this.navigateHome(page);
    const deadline = Date.now() + this.authenticationTimeoutMs;
    while (Date.now() < deadline) {
      if (await isAuthenticatedPage(page)) return;
      await delay(500);
    }
    throw new NotebookLmError(
      "NOTEBOOKLM_LOGIN_TIMEOUT",
      "Google 登录未在限定时间内完成，请在 Edge 窗口中完成登录后重试。",
    );
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const page = await this.providePage();
    await this.navigateHome(page);
    await this.requireAuthentication(page);

    const cards = page.locator("mat-card.project-button-card");
    await waitForNotebookHome(page, cards, this.navigationTimeoutMs);
    const snapshots = await cards.evaluateAll((elements) =>
      elements.map((card) => ({
        featured: card.classList.contains("cover-image-card"),
        href: card.querySelector('a[href*="/notebook/"]')?.getAttribute("href") ?? "",
        title: card.querySelector(".project-button-title")?.textContent ?? "",
      })),
    );
    const notebooks = mapNotebookCards(snapshots, page.url());
    const recentCardCount = snapshots.filter((snapshot) => !snapshot.featured).length;
    if (recentCardCount > 0 && notebooks.length === 0) {
      throw new NotebookLmError(
        "NOTEBOOKLM_UI_CHANGED",
        "Gemini Notebook 页面结构可能已经变化，无法配对 Notebook 标题与真实链接。",
      );
    }
    return notebooks;
  }

  async uploadFile(
    notebook: NotebookInfo,
    filePath: string,
    onProgress?: NotebookLmUploadProgressListener,
  ): Promise<void> {
    await validatePptxFile(filePath);
    const notebookUrl = validateNotebook(notebook);
    const page = await this.providePage();
    await this.requireAuthentication(page);

    onProgress?.({ stage: "opening-notebook", message: "正在打开 Notebook" });
    await page.goto(notebookUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.navigationTimeoutMs,
    });
    const addSource = page.getByLabel(/^(添加来源|Add source)$/i).first();
    try {
      await addSource.waitFor({ state: "visible", timeout: this.navigationTimeoutMs });
    } catch (error) {
      if (await isAuthenticatedPage(page)) {
        throw new NotebookLmError(
          "NOTEBOOKLM_NOTEBOOK_READ_ONLY",
          "该 Notebook 当前不可编辑，无法添加来源。",
          { cause: error },
        );
      }
      throw new NotebookLmError("NOTEBOOKLM_AUTH_REQUIRED", "Gemini Notebook 登录已过期，请重新登录。", {
        cause: error,
      });
    }

    onProgress?.({ stage: "opening-source-dialog", message: "正在打开添加来源" });
    let dialog = page.getByRole("dialog").last();
    if (!(await dialog.isVisible().catch(() => false))) {
      await addSource.click({ timeout: this.navigationTimeoutMs });
      dialog = page.getByRole("dialog").last();
    }
    await dialog.waitFor({ state: "visible", timeout: this.navigationTimeoutMs });

    const uploadButton = dialog.getByRole("button", { name: /上传文件|Upload files?/i });
    if ((await uploadButton.count()) !== 1) {
      throw new NotebookLmError("NOTEBOOKLM_UI_CHANGED", "Gemini Notebook 上传入口可能已经变化。");
    }

    onProgress?.({ stage: "choosing-file", message: "正在选择 PPTX 文件" });
    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: this.navigationTimeoutMs,
    });
    await uploadButton.click({ timeout: this.navigationTimeoutMs });
    const fileChooser = await fileChooserPromise;
    const accepted = sanitizeAccept((await fileChooser.element().getAttribute("accept")) ?? "");
    if (accepted.length > 0 && !accepted.includes(".pptx")) {
      throw new NotebookLmError(
        "NOTEBOOKLM_UNSUPPORTED_FILE",
        "Gemini Notebook 当前上传控件不接受 PPTX 文件。",
      );
    }

    onProgress?.({ stage: "uploading", message: "正在上传 PPTX" });
    await fileChooser.setFiles(filePath);
    await waitForUploadResult(page, dialog, basename(filePath), this.uploadTimeoutMs);
    onProgress?.({ stage: "completed", message: "PPTX 已上传" });
  }

  private async navigateHome(page: Page): Promise<void> {
    const currentHost = getSupportedHost(page.url());
    if (currentHost && new URL(page.url()).pathname === "/") return;
    await page.goto(this.homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.navigationTimeoutMs,
    });
  }

  private async requireAuthentication(page: Page): Promise<void> {
    if (!(await isAuthenticatedPage(page))) {
      throw new NotebookLmError("NOTEBOOKLM_AUTH_REQUIRED", "Gemini Notebook 登录已过期，请重新登录。");
    }
  }
}

export function mapNotebookCards(snapshots: NotebookCardSnapshot[], baseUrl: string): NotebookInfo[] {
  const notebooks = new Map<string, NotebookInfo>();
  for (const snapshot of snapshots) {
    if (snapshot.featured) continue;
    const title = normalizeWhitespace(snapshot.title);
    const parsed = parseNotebookHref(snapshot.href, baseUrl);
    if (!title || !parsed || notebooks.has(parsed.id)) continue;
    notebooks.set(parsed.id, { id: parsed.id, title, url: parsed.url });
  }
  return [...notebooks.values()];
}

export function parseNotebookHref(href: string, baseUrl: string): { id: string; url: string } | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, baseUrl);
    if (!SUPPORTED_HOSTS.has(url.hostname)) return undefined;
    const match = /^\/notebook\/([^/?#]+)\/?$/.exec(url.pathname);
    const id = match?.[1];
    if (!id) return undefined;
    return { id: decodeURIComponent(id), url: `${url.origin}${url.pathname}` };
  } catch {
    return undefined;
  }
}

function validateNotebook(notebook: NotebookInfo): string {
  if (!notebook.url) {
    throw new NotebookLmError(
      "NOTEBOOKLM_INVALID_NOTEBOOK",
      "Notebook 缺少从真实页面读取的 URL，不能根据标题生成假 ID。",
    );
  }
  const parsed = parseNotebookHref(notebook.url, DEFAULT_HOME_URL);
  if (!parsed || parsed.id !== notebook.id) {
    throw new NotebookLmError("NOTEBOOKLM_INVALID_NOTEBOOK", "Notebook ID 与真实 URL 不匹配。");
  }
  return parsed.url;
}

async function validatePptxFile(filePath: string): Promise<void> {
  if (extname(filePath).toLowerCase() !== ".pptx") {
    throw new NotebookLmError("NOTEBOOKLM_UNSUPPORTED_FILE", "只能上传 .pptx 文件。");
  }
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size <= 0) throw new Error("not a non-empty file");
  } catch (error) {
    throw new NotebookLmError("NOTEBOOKLM_FILE_NOT_FOUND", "未找到可上传的 PPTX 文件，或文件为空。", {
      cause: error,
    });
  }
}

async function isAuthenticatedPage(page: Page): Promise<boolean> {
  if (!getSupportedHost(page.url())) return false;
  const [notebookCards, addSource, createNotebook, signIn] = await Promise.all([
    page
      .locator('a[href*="/notebook/"]')
      .count()
      .catch(() => 0),
    page
      .getByLabel(/^(添加来源|Add source)$/i)
      .count()
      .catch(() => 0),
    page
      .getByRole("button", { name: /^(新建笔记本|New notebook|Create new notebook)$/i })
      .count()
      .catch(() => 0),
    page
      .getByText(/^(登录|Sign in)$/i)
      .count()
      .catch(() => 0),
  ]);
  return signIn === 0 && (notebookCards > 0 || addSource > 0 || createNotebook > 0);
}

async function waitForNotebookHome(page: Page, cards: Locator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cards.count()) > 0) return;
    const createNotebook = await page
      .getByRole("button", { name: /^(新建笔记本|New notebook|Create new notebook)$/i })
      .count()
      .catch(() => 0);
    if (createNotebook > 0) return;
    await delay(250);
  }
  throw new NotebookLmError("NOTEBOOKLM_UI_CHANGED", "Gemini Notebook 首页结构可能已经变化。");
}

async function waitForUploadResult(
  page: Page,
  dialog: Locator,
  fileName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const duplicate = page.getByText(/(duplicate|already exists|重复|已存在)/i);
  const failure = page.getByText(/(upload failed|couldn't upload|无法上传|上传失败)/i);
  const uploadedFile = page.getByText(fileName, { exact: true });

  while (Date.now() < deadline) {
    if (await anyVisible(duplicate)) {
      throw new NotebookLmError("NOTEBOOKLM_DUPLICATE_SOURCE", "Notebook 中可能已经存在同名来源。");
    }
    if (await anyVisible(failure)) {
      throw new NotebookLmError("NOTEBOOKLM_UPLOAD_FAILED", "Gemini Notebook 报告上传失败。");
    }
    const [fileVisible, dialogVisible, progressVisible] = await Promise.all([
      anyVisible(uploadedFile),
      dialog.isVisible().catch(() => false),
      anyVisible(page.getByRole("progressbar")),
    ]);
    if (fileVisible && !dialogVisible && !progressVisible) return;
    await delay(500);
  }
  throw new NotebookLmError("NOTEBOOKLM_UPLOAD_TIMEOUT", "等待 Gemini Notebook 确认上传完成超时。");
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (
      await locator
        .nth(index)
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}

function sanitizeAccept(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^\.?[a-z0-9*+/-]+$/.test(item));
}

function getSupportedHost(value: string): string | undefined {
  try {
    const hostname = new URL(value).hostname;
    return SUPPORTED_HOSTS.has(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
