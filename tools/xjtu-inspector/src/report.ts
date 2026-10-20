import { writeFile } from "node:fs/promises";

import type { EndpointSummary } from "./network-recorder";

export async function writeDiscoveryReport(
  outputPath: string,
  capturedAt: string,
  logPath: string,
  endpoints: EndpointSummary[],
): Promise<void> {
  const rows = endpoints.length
    ? endpoints
        .map(
          (item) =>
            `| \`${escapeCell(item.endpoint)}\` | ${item.methods.join(", ")} | ${item.resourceTypes.join(", ")} | ${item.statuses.join(", ")} | ${escapeCell(item.contentTypes.join(", "))} | ${item.count} |`,
        )
        .join("\n")
    : "| _未捕获_ |  |  |  |  | 0 |";

  const markdown = `# 西交课堂 API 分析

> Inspector 抓取时间：${capturedAt}
>
> 状态：已生成脱敏网络清单；接口语义必须结合本次真实操作和脱敏 JSON 响应继续判读，不能仅凭 URL 猜测。

原始脱敏事件位于忽略提交的本地文件：\`${logPath.replaceAll("\\", "/")}\`。

## 已观察端点

| Endpoint | Method | Resource type | Status | Content-Type | Count |
|---|---|---|---|---|---:|
${rows}

## 课程列表 API

待根据本次课程列表操作对应的请求与响应确认。

## 课程详情 API

待根据打开课程操作对应的请求与响应确认。

## 课堂列表 API

待根据课堂回放列表操作对应的请求与响应确认。

## 视频列表与 URL 获取方式

待根据打开回放、切换视角和播放操作对应的请求确认。必须进一步标记 MP4/HLS/DASH、master/media playlist、signed URL 参数名称及有效期现象。

## 双视角字段

待从真实 JSON 响应中确认；不得依据数组顺序猜测视角含义。

## 认证、Header 与 Cookie 机制

Inspector 已记录 header 的存在与非敏感值，但 Cookie、Authorization、CSRF/token、CAS ticket、session 和 signed query 值均已自动替换为 \`[REDACTED]\`。待确认哪些 header 对 API/media 请求是必要的。

## 分页与学期机制

待从真实请求参数和响应分页元数据确认。

## 错误返回格式

本次若未自然出现 401/403/500，不会主动枚举或制造未授权请求。后续只通过安全 mock fixture 覆盖未观察到的错误状态。
`;

  await writeFile(outputPath, markdown, "utf8");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
