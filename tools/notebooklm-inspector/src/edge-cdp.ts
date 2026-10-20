import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext } from "playwright";

const CDP_START_TIMEOUT_MS = 30_000;

export interface EdgeCdpSession {
  browser: Browser;
  context: BrowserContext;
  process: ChildProcess;
}

export function buildEdgeArguments(profileDirectory: string, port: number, targetUrl: string): string[] {
  return [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDirectory}`, targetUrl];
}

export async function findEdgeExecutable(): Promise<string> {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(
    (value): value is string => Boolean(value),
  );
  const candidates = roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe"));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking the real installation candidates.
    }
  }

  throw new Error("未找到 Microsoft Edge。请安装 Edge，或在 NotebookLM Inspector 中配置实际 Edge 路径。");
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地 Edge 调试端口。"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForCdp(endpoint: string, edgeProcess: ChildProcess): Promise<void> {
  const deadline = Date.now() + CDP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (edgeProcess.exitCode !== null) {
      throw new Error(`Microsoft Edge 在调试接口就绪前退出（exit ${edgeProcess.exitCode}）。`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const details = (await response.json()) as { webSocketDebuggerUrl?: unknown };
        if (typeof details.webSocketDebuggerUrl === "string") return;
      }
    } catch {
      // Edge may still be starting; retry until the bounded deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("等待 Microsoft Edge 调试接口超时。请关闭专用 Edge 窗口后重试。");
}

export async function launchEdgeCdpSession(
  profileDirectory: string,
  targetUrl: string,
): Promise<EdgeCdpSession> {
  const [executablePath, port] = await Promise.all([findEdgeExecutable(), allocateLoopbackPort()]);
  const endpoint = `http://127.0.0.1:${port}`;
  const edgeProcess = spawn(executablePath, buildEdgeArguments(profileDirectory, port, targetUrl), {
    stdio: "ignore",
    windowsHide: false,
  });

  try {
    await waitForCdp(endpoint, edgeProcess);
    const browser = await chromium.connectOverCDP(endpoint, {
      isLocal: true,
      noDefaults: true,
      timeout: 10_000,
    });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error("Edge 调试连接没有返回默认浏览器上下文。");
    }
    return { browser, context, process: edgeProcess };
  } catch (error) {
    if (edgeProcess.exitCode === null) edgeProcess.kill();
    throw error;
  }
}

export async function verifyJavaScriptEnabled(context: BrowserContext): Promise<boolean> {
  const verificationPage = await context.newPage();
  try {
    await verificationPage.goto(
      "data:text/html,<script>document.documentElement.dataset.javascript='enabled'</script>",
    );
    return (await verificationPage.locator("html").getAttribute("data-javascript")) === "enabled";
  } finally {
    await verificationPage.close().catch(() => undefined);
  }
}
