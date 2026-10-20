# XJTU Lecture2PPT 架构

## 产品范围

当前桌面产品负责“西交课堂回放 → 本地 PDF + TXT”。NotebookLM/Google 集成已从产品范围中移除；历史研究代码不注册到桌面进程，也不进入主界面。

## 进程结构

```text
React Renderer（无 Node.js 权限）
  ↓ narrow IPC exposed by Preload
Electron Main
  ├─ XjtuService / persistent login session
  ├─ DownloadService / streaming MP4
  ├─ PipelineService / persisted job state machine
  ├─ ConversionService / hidden sandboxed renderer
  ├─ AppService / settings, PDF/TXT library, orphan cleanup
  └─ filesystem / shell operations

Conversion Renderer
  └─ video seek → difference detection → JPEG frames → PptxGenJS
```

主窗口和转换窗口均启用 `contextIsolation` 与 `sandbox`，并关闭 `nodeIntegration`。Renderer 只能调用 Preload 中显式声明的 IPC。

## 任务状态与持久化

统一任务状态：

```text
queued → authenticating → resolving-video → downloading → downloaded
       → converting → converting-pdf → recognizing-text
       → writing-output → cleaning → completed
```

任意运行阶段都可以进入 `failed` 或 `cancelled`。任务记录原子写入：

```text
userData/state/pipeline-jobs.json.part
  ↓ rename
userData/state/pipeline-jobs.json
```

应用启动时恢复历史任务。上次退出时仍处于运行状态的任务会标记为失败，并提供重新处理入口，避免自动重复下载或重复写入 PPT。

## 下载与临时文件

下载目录：

```text
userData/temp/jobs/<download-job-id>/
  ├─ source.mp4
  ├─ source.mp4.part
  ├─ metadata.json
  └─ frames/
```

MP4 使用流式写入，不把完整视频载入内存。设置允许 1～2 个并发下载；转换并发固定为 1。

超过设置保留期限的孤立任务目录会在启动时清理。失败或取消任务是否自动保留由 `retainFailedTemporaryFiles` 控制，用户也可以在任务页手动删除。

## PDF/TXT 写入与清理顺序

```text
生成临时 PPTX ArrayBuffer（video-to-ppt）
  ↓
校验 ZIP/PPTX 结构与 slide 数量
  ↓
写入任务目录 intermediate.pptx
  ↓
LibreOffice 转为 PDF；RapidOCR 识别 PPTX 内的关键帧图片
  ↓
分别写入 <output>.pdf.part 与 <output>.txt.part
  ↓
验证 PDF 与 TXT 并成对 rename
  ↓
删除 intermediate.pptx
  ↓
按设置删除 source.mp4 / part / frames
  ↓
任务 completed
```

任何转换、OCR、写入或校验失败都会保留源视频和中间 PPTX。若 PDF/TXT 已成功但视频清理失败，任务报告失败并保留可理解的错误信息，不会宣称完整成功。

## 设置与 PPT Library

设置保存在 `userData/settings.json`，采用临时文件加原子重命名写入。包含：

- 输出目录
- 默认学期
- 下载并发
- 成功后自动删除视频
- 失败任务临时文件保留策略
- 孤立文件保留天数

PPT Library 扫描当前输出目录中同名的 `.pdf` + `.txt` 文件对。文件名中的课程名称与课堂日期用于按课程分组；支持文件名搜索。打开、定位和成对删除操作均由 Main Process 完成，并验证目标仍位于输出目录内。

## 文档导出模块

`packages/document-exporter` 不依赖 Electron，负责三件事：

1. 按 PptxGenJS 的真实 OOXML 媒体条目读取关键帧图片；
2. 复用 Umi-OCR 的 RapidOCR 管道协议，以 Base64 发送图片并使用其排版思路生成文本；
3. 复用 `libreoffice-convert` 的隔离 profile 与 headless 调用方式生成 PDF。

RapidOCR 使用 Base64 而不是本地图片路径，因为真实测试确认旧版引擎在中文 Windows 用户目录下会损坏路径字符。OCR 子进程在单个任务内串行复用，任务结束或取消后由应用主动终止。

## 认证与日志

西交网页只用于用户本人完成统一身份认证。课程和视频数据通过已经由 Inspector 实际确认的 API 获取，不抓取课程卡片 DOM。

Session 数据使用 Electron Session 与 Windows `safeStorage`，程序不保存明文密码。结构化日志在写入前统一脱敏 Cookie、Authorization、CAS ticket、token、session ID 和 signed URL 敏感参数。

## 媒体边界

实际验证媒体为 MP4。下载器会识别 HLS、DASH 和未知类型并明确返回不支持；在没有重新抓取真实请求前，不猜测新的媒体接口或参数。发现 DRM/Widevine 时必须停止，不提供绕过逻辑。
