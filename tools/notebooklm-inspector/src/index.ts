import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { launchEdgeCdpSession, verifyJavaScriptEnabled } from "./edge-cdp";
import { NotebookLmObserver } from "./observer";
import { writeNotebookLmReport } from "./report";

const TARGET_URL = "https://notebook.google.com/";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const browserArgument = process.argv.find((argument) => argument.startsWith("--browser="));
const browserName = browserArgument?.split("=", 2)[1]?.toLowerCase() === "edge" ? "edge" : "chromium";
const profileDirectory = resolve(
  repositoryRoot,
  ".dev-session",
  browserName === "edge" ? "notebooklm-inspector-edge-cdp" : "notebooklm-inspector",
);
const logDirectory = resolve(repositoryRoot, ".network-logs", "notebooklm-inspector");
const reportPath = resolve(repositoryRoot, "docs", "notebooklm-integration.md");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const observationPath = resolve(logDirectory, `${runId}.json`);

await Promise.all([mkdir(profileDirectory, { recursive: true }), mkdir(logDirectory, { recursive: true })]);

const observer = new NotebookLmObserver();
let browser: Browser | null = null;
let context: BrowserContext;
let waitUntilClosed: Promise<void>;

if (browserName === "edge") {
  const edgeSession = await launchEdgeCdpSession(profileDirectory, TARGET_URL);
  browser = edgeSession.browser;
  context = edgeSession.context;
  waitUntilClosed = new Promise<void>((resolveClosed) =>
    edgeSession.browser.once("disconnected", () => resolveClosed()),
  );
} else {
  context = await chromium.launchPersistentContext(profileDirectory, {
    acceptDownloads: false,
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--no-sandbox"],
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  waitUntilClosed = new Promise<void>((resolveClosed) => context.once("close", () => resolveClosed()));
}

const attachedPages = new WeakSet<Page>();
const attach = (page: Page): void => {
  if (attachedPages.has(page)) return;
  attachedPages.add(page);
  observer.attach(page);
};
for (const page of context.pages()) attach(page);
context.on("page", attach);

let closing = false;
const closeContext = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  if (browser) {
    await browser.close().catch(() => undefined);
  } else {
    await context.close().catch(() => undefined);
  }
};
process.once("SIGINT", () => void closeContext());
process.once("SIGTERM", () => void closeContext());

const page = context.pages()[0] ?? (await context.newPage());
attach(page);
page.setDefaultNavigationTimeout(60_000);

console.log(
  `NotebookLM Inspector 已使用 ${browserName === "edge" ? "正常 Edge + 官方 CDP 附加" : "Chromium"} 启动。不会记录密码、Cookie、token、账号、Notebook 标题或真实 ID。`,
);
const javaScriptEnabled = await verifyJavaScriptEnabled(context).catch(() => false);
console.log(`JavaScript 运行验证：${javaScriptEnabled ? "已启用" : "未通过"}`);
if (!javaScriptEnabled) {
  console.error("Edge JavaScript 未启用，请在 Edge 设置中允许 JavaScript 后重试。");
}
console.log("请在浏览器中由你本人完成 Google 登录（包括可能出现的 2FA、Passkey 或安全确认）。");
console.log(
  "登录后请依次：打开一个 Notebook → Add source/添加来源 → Upload/上传 → 让文件选择窗口出现后取消。\n操作完成后关闭整个 Chromium 窗口。",
);

await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
  console.error(`NotebookLM 初始页面加载失败，浏览器仍保持打开：${String(error)}`);
});

const inspectTimer = setInterval(() => {
  for (const candidate of context.pages()) {
    attach(candidate);
    void observer.inspect(candidate).catch(() => undefined);
  }
}, 1_500);

await waitUntilClosed;
clearInterval(inspectTimer);
await observer.drain();
const observation = observer.snapshot();
await writeFile(observationPath, JSON.stringify(observation, null, 2), "utf8");
await writeNotebookLmReport(reportPath, new Date().toISOString(), observation);
console.log(`脱敏观察记录：${relative(repositoryRoot, observationPath)}`);
console.log(`集成分析文档：${relative(repositoryRoot, reportPath)}`);
