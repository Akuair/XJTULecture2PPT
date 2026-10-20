import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { NotebookLmError } from "./errors";

const DEFAULT_HOME_URL = "https://notebook.google.com/";
const PRODUCT_HOSTS = new Set(["notebook.google.com", "notebook.google", "notebooklm.google.com"]);

export interface EdgeNotebookLmSessionOptions {
  edgeExecutablePath?: string;
  homeUrl?: string;
  profileDirectory: string;
  startupTimeoutMs?: number;
}

export class EdgeNotebookLmSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private launchPromise: Promise<void> | undefined;
  private readonly homeUrl: string;
  private readonly startupTimeoutMs: number;

  constructor(private readonly options: EdgeNotebookLmSessionOptions) {
    this.homeUrl = options.homeUrl ?? DEFAULT_HOME_URL;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  }

  async getPage(): Promise<Page> {
    await this.ensureConnected();
    const context = this.context;
    if (!context) {
      throw new NotebookLmError("NOTEBOOKLM_UI_CHANGED", "无法连接 Gemini Notebook 浏览器会话。");
    }
    const productPage = context.pages().find((page) => isProductUrl(page.url()));
    return productPage ?? context.pages()[0] ?? (await context.newPage());
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.clearConnection();
    if (browser?.isConnected()) {
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close");
      } catch {
        await browser.close().catch(() => undefined);
      }
    }
  }

  isRunning(): boolean {
    return Boolean(this.browser?.isConnected());
  }

  private async ensureConnected(): Promise<void> {
    if (this.browser?.isConnected() && this.context) return;
    this.launchPromise ??= this.launch();
    try {
      await this.launchPromise;
    } finally {
      this.launchPromise = undefined;
    }
  }

  private async launch(): Promise<void> {
    await mkdir(this.options.profileDirectory, { recursive: true });
    const [executablePath, port] = await Promise.all([
      this.options.edgeExecutablePath
        ? verifyExecutable(this.options.edgeExecutablePath)
        : findEdgeExecutable(),
      allocateLoopbackPort(),
    ]);
    const endpoint = `http://127.0.0.1:${port}`;
    const edgeProcess = spawn(
      executablePath,
      buildEdgeArguments(this.options.profileDirectory, port, this.homeUrl),
      { stdio: "ignore", windowsHide: false },
    );
    try {
      await waitForCdp(endpoint, edgeProcess, this.startupTimeoutMs);
      const browser = await chromium.connectOverCDP(endpoint, {
        isLocal: true,
        noDefaults: true,
        timeout: 10_000,
      });
      const context = browser.contexts()[0];
      if (!context) throw new Error("Edge CDP did not return a default context");
      this.browser = browser;
      this.context = context;
      browser.once("disconnected", () => this.clearConnection(browser));
    } catch (error) {
      if (edgeProcess.exitCode === null) edgeProcess.kill();
      this.clearConnection();
      throw new NotebookLmError("NOTEBOOKLM_UI_CHANGED", "无法启动或连接 Microsoft Edge。", { cause: error });
    }
  }

  private clearConnection(expectedBrowser?: Browser): void {
    if (expectedBrowser && this.browser !== expectedBrowser) return;
    this.browser = undefined;
    this.context = undefined;
  }
}

export function buildEdgeArguments(profileDirectory: string, port: number, homeUrl: string): string[] {
  return [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDirectory}`, homeUrl];
}

async function verifyExecutable(value: string): Promise<string> {
  await access(value);
  return value;
}

async function findEdgeExecutable(): Promise<string> {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  );
  for (const root of roots) {
    const candidate = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    try {
      return await verifyExecutable(candidate);
    } catch {
      // Continue checking the actual standard installation locations.
    }
  }
  throw new Error("Microsoft Edge executable was not found");
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForCdp(endpoint: string, edgeProcess: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (edgeProcess.exitCode !== null) throw new Error("Edge exited before CDP was ready");
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const details = (await response.json()) as { webSocketDebuggerUrl?: unknown };
        if (typeof details.webSocketDebuggerUrl === "string") return;
      }
    } catch {
      // Edge may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("Timed out waiting for Edge CDP");
}

function isProductUrl(value: string): boolean {
  try {
    return PRODUCT_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}
