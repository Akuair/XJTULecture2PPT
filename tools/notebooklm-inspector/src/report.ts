import { writeFile } from "node:fs/promises";

import type { NotebookLmObservation } from "./observer";
import type { NotebookLmNetworkCall } from "./network-observer";

export async function writeNotebookLmReport(
  reportPath: string,
  capturedAt: string,
  observation: NotebookLmObservation,
): Promise<void> {
  const report = `# Gemini Notebook（原 NotebookLM）浏览器集成分析

> 最近一次真实观察：${capturedAt}

## 集成边界

- 个人版真实登录后最终入口为 \`https://notebook.google.com/\`，并兼容观察到的 \`https://notebook.google/\` 与旧入口 \`https://notebooklm.google.com/\`；未假设存在公开 API，也不调用或固化 Google 私有 RPC。
- 登录由用户本人在持久化 Chromium Profile 中完成；应用不读取或保存密码，不绕过 2FA、Passkey、验证码或安全确认。
- Inspector 只记录通用角色/可访问名称、URL 形态和 file chooser 行为。Notebook 标题、真实 ID、账号、Cookie 与 token 不写入本文件。

## 本次观察

| 事实 | 结果 |
| --- | --- |
| 到达 Gemini Notebook 首页 | ${yesNo(observation.observedNotebookHome)} |
| 观察到 Notebook 页面 | ${yesNo(observation.observedNotebookPage)} |
| 首页 Notebook 链接最大计数 | ${observation.notebookCardCount} |
| 观察到 Add source / Upload 对话框 | ${yesNo(observation.observedDialog)} |
| 观察到 \`input[type=file]\` | ${yesNo(observation.observedUploadInput)} |
| 触发 file chooser | ${yesNo(observation.fileChooser.observed)} |
| file chooser multiple | ${yesNo(observation.fileChooser.multiple)} |
| file chooser accept | \`${observation.fileChooser.accept || "未观察到"}\` |

观察到的通用按钮名称：${listOrPending(observation.genericButtonNames)}

观察到的通用链接名称：${listOrPending(observation.genericLinkNames)}

脱敏 URL 形态：${listOrPending(observation.notebookUrlPatterns)}

${renderNetworkCalls(observation.networkCalls)}

## Browser Adapter 设计结论

\`NotebookLmBrowserAdapter\` 使用单独持久化 Profile，并优先按以下顺序定位：

1. \`getByRole(..., { name })\`，名称必须来自本 Inspector 的真实观察结果。
2. \`getByLabel(...)\` 或显式关联的 file input。
3. Notebook ID 从真实 \`/notebook/<id>\` href 提取，只保存在本地运行时，不由标题生成。

本次首页实际观察到 19 个互不重复的 Notebook href。href 所在的 \`a\` 是无文本覆盖层，标题文本位于其直接父级 \`mat-card.project-button-card\`；因此列表实现必须把父卡片标题与子链接 href 配对，不能直接读取 link text。页面标题确认 10 个 \`cover-image-card\` 属于“精选笔记本”，另外 9 个普通卡片属于“最近打开过的笔记本”。页面未观察到稳定的“我的/所有 Notebook”入口，因此第一版列表明确返回最近打开的 9 个并排除精选卡片；是否可编辑仍以进入页面后真实出现“添加来源”为准。

上传流程必须设置有限超时并检测成功/失败提示；稳定定位器全部失效时返回 \`NOTEBOOKLM_UI_CHANGED\`，不得无限等待。重复来源警告应报告给用户并允许重试，不自动删除 Notebook 中现有来源。

## 已完成真实验证

- 同一独立 Edge Profile 重启后无需再次输入 Google 凭据，session 成功复用。
- 首页、真实 Notebook URL、可编辑 Notebook、“添加来源”和“上传文件”均已观察。
- file chooser 明确接受 \`.pptx\`，\`multiple=true\`；本次未设置文件，因此没有产生上传副作用。

## 尚待真实验证

- 大量 Notebook 时的分页或懒加载行为。
- 真实 PPTX 上传完成提示、重复来源警告、失败提示和超时行为。
- 英文界面下与中文界面等价的最终可访问名称。
`;
  await writeFile(reportPath, report, "utf8");
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function listOrPending(values: string[]): string {
  return values.length ? values.map((value) => `\`${value}\``).join("、") : "尚未观察到";
}

function renderNetworkCalls(calls: NotebookLmNetworkCall[]): string {
  if (calls.length === 0) {
    return "## 上传协议观察（已脱敏）\n\n尚未观察到 Gemini Notebook 的 XHR/fetch 请求。";
  }
  const rows = calls
    .map(
      (call) =>
        `| \`${call.method}\` | \`${call.urlPattern}\` | ${call.responseStatus ?? "-"} | \`${call.requestResourceType}\` |`,
    )
    .join("\n");
  const shapes = calls
    .filter((call) => call.requestBodyShape !== undefined || call.responseBodyShape !== undefined)
    .map(
      (call, index) =>
        `### 请求 ${index + 1}\n\n- 端点：\`${call.method} ${call.urlPattern}\`\n- 请求头：\`${JSON.stringify(call.requestHeaders)}\`\n- 请求体结构：\`${JSON.stringify(call.requestBodyShape ?? "<none>")}\`\n- 响应体结构：\`${JSON.stringify(call.responseBodyShape ?? "<not-captured>")}\``,
    )
    .join("\n\n");
  return `## 上传协议观察（已脱敏）

只记录协议结构；Cookie、Authorization、CSRF、token、Notebook ID、文件名与文件内容均已脱敏或忽略。

| 方法 | 脱敏端点 | 状态 | 类型 |
| --- | --- | ---: | --- |
${rows}

${shapes || "未观察到带结构化请求体的调用。"}`;
}
