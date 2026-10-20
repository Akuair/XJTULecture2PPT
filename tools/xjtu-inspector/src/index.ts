import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { NetworkRecorder } from "./network-recorder";
import { writeDiscoveryReport } from "./report";

const TARGET_URL = "https://class.xjtu.edu.cn/user/courses#/?pageIndex=1";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const profileDirectory = resolve(repositoryRoot, ".dev-session", "xjtu-inspector");
const logDirectory = resolve(repositoryRoot, ".network-logs", "xjtu-inspector");
const downloadsDirectory = resolve(repositoryRoot, "downloads", "xjtu-inspector");
const reportPath = resolve(repositoryRoot, "docs", "xjtu-api-analysis.md");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logPath = resolve(logDirectory, `${runId}.jsonl`);
const autoCloseArgument = process.argv.find((argument) => argument.startsWith("--auto-close-ms="));
const autoCloseMs = autoCloseArgument ? Number(autoCloseArgument.split("=", 2)[1]) : undefined;

await Promise.all([
  mkdir(profileDirectory, { recursive: true }),
  mkdir(logDirectory, { recursive: true }),
  mkdir(downloadsDirectory, { recursive: true }),
]);

const recorder = new NetworkRecorder(logPath);
const context = await chromium.launchPersistentContext(profileDirectory, {
  acceptDownloads: true,
  downloadsPath: downloadsDirectory,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

context.on("request", (request) => recorder.track(recorder.recordRequest(request)));
context.on("response", (response) => recorder.track(recorder.recordResponse(response)));

let closing = false;
const closeContext = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await context.close().catch(() => undefined);
};
process.once("SIGINT", () => void closeContext());
process.once("SIGTERM", () => void closeContext());

const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultNavigationTimeout(60_000);

console.log("XJTU Inspector 已启动。所有凭据、身份字段和 signed URL 敏感参数都会脱敏。");
console.log("请在浏览器中完成登录，然后依次打开课程、课堂回放、切换全部视频视角并开始播放。");
console.log("操作完成后关闭整个 Chromium 窗口，Inspector 将写出端点清单。");

await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
  console.error(`初始页面加载失败，浏览器仍保持打开：${String(error)}`);
});

let redirectingToCourseList = false;
const courseListWatcher = setInterval(() => {
  if (redirectingToCourseList || page.isClosed()) return;
  try {
    const currentUrl = new URL(page.url());
    const isAuthenticatedAppPage =
      currentUrl.hostname === "class.xjtu.edu.cn" &&
      !currentUrl.pathname.startsWith("/auth/") &&
      currentUrl.pathname !== "/login";
    if (isAuthenticatedAppPage && currentUrl.pathname !== "/user/courses") {
      redirectingToCourseList = true;
      void page
        .goto(TARGET_URL, { waitUntil: "domcontentloaded" })
        .catch((error: unknown) => console.error(`跳转课程列表失败：${String(error)}`))
        .finally(() => {
          redirectingToCourseList = false;
        });
    }
  } catch {
    // Ignore intermediate about:blank and malformed navigation URLs.
  }
}, 1_000);

if (autoCloseMs !== undefined && Number.isFinite(autoCloseMs) && autoCloseMs > 0) {
  setTimeout(() => void closeContext(), autoCloseMs);
}

await new Promise<void>((resolveClosed) => context.once("close", () => resolveClosed()));
clearInterval(courseListWatcher);
await recorder.finish();

const relativeLogPath = relative(repositoryRoot, logPath);
await writeDiscoveryReport(reportPath, new Date().toISOString(), relativeLogPath, recorder.getSummaries());
console.log(`脱敏日志已写入：${relativeLogPath}`);
console.log(`端点清单已写入：${relative(repositoryRoot, reportPath)}`);
if (recorder.getCaptureErrorCount() > 0) {
  console.warn(`浏览器关闭期间忽略了 ${recorder.getCaptureErrorCount()} 个已失效的网络事件。`);
}
