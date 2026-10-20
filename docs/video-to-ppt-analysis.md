# `liwenka1/video-to-ppt` 技术分析

## 审读基线

- 上游：`https://github.com/liwenka1/video-to-ppt`
- 审读提交：`af79bb9e7ef460b0162408fd866049edfd07da72`
- 提交时间：2025-11-10 19:24:58 +0800
- 许可证：MIT；抽取任何实质代码时必须随 `packages/video-to-ppt-core` 保留上游 `LICENSE` 和 attribution。
- 已审读：`lib/video-processing.ts`、`lib/video-diagnostics.ts`、`lib/ppt-generation.ts`、`lib/utils.ts`、`app/local-video/page.tsx`、`app/screen-recording/page.tsx`，以及应用入口、配置、样式、依赖和 README。

终端显示上游部分中文时存在编码错显，但不影响 TypeScript 控制流和算法判断。

## 真实调用链

### 本地视频页面（正式页面当前实际使用的路径）

```text
用户选择 File
  → 检查扩展名/MIME/200 MB 限制
  → 非 MP4：convertToMp4(File)
      → 下载 FFmpeg core/wasm
      → fetchFile 把完整 Blob 写入 FFmpeg.wasm FS
      → 先尝试 stream copy，失败后 H.264/AAC 重编码
      → readFile 把完整 MP4 再读回 Blob
  → URL.createObjectURL(File)
  → <video> 读取 metadata
  → preprocessVideo(video, canvas)
      → 在全片均匀采样 20～50 帧
      → 相邻帧亮度 RMS 差异的中位数
      → 阈值限制在 [10, 60]
  → extractFramesFromVideo(video, canvas)
      → 每 3 秒 seek 一次
      → Canvas getImageData
      → 与上一采样帧计算亮度 RMS 差异
      → 超过阈值则导出质量 0.8 的 JPEG Blob/object URL
      → 最多 256 张；连续 21 次无新图时提前结束
  → createAndDownloadPPT(screenshotUrls)
      → PptxGenJS 新建标题页
      → 每张截图生成一页
      → pptx.writeFile() 触发浏览器下载
```

`app/local-video/page.tsx` 没有调用 `processVideoWithWebAV` 或 `analyzeVideoContent`。页面注释中的 “WebAV enhancements” 与实际调用不一致；真实关键帧路径是 HTMLVideoElement + Canvas。

### WebAV 实验路径

`processVideoWithWebAV(File)` 动态加载 `@webav/av-cliper`，用 `MP4Clip(file.stream())` 获取以微秒计的时长，然后在全片均匀抽取最多约 50 帧。每帧通过 `MP4Clip.tick(time)` 得到 `VideoFrame`，绘制到 Canvas 并导出 JPEG object URL。每累计 10 帧创建一个 `scene` 记录；这不是内容驱动的场景检测。

### 录屏路径

录屏页面通过 `getDisplayMedia` + `MediaRecorder` 产生录屏，同时周期性调用 `captureAndFilterScreenshot`。该函数同样使用 Canvas 和亮度 RMS 差异阈值；第一帧必收，后续超过阈值才保存。停止后把所有录制 chunk 合并为 Blob，并可把截图交给同一 PPT 生成函数。

## 可复用部分

1. `calculateImageDifference` 的 Rec.709 亮度加权与 RMS 差异计算。抽取时会改为与 React 无关的纯函数，并为尺寸不一致、空帧和降采样增加保护与测试。
2. `preprocessVideo` 的“均匀采样 → 中位数 → [10, 60] 限幅”策略。它适合作为默认自动阈值，但必须允许用户覆盖。
3. `extractFramesFromVideo` 的 seek/canvas/差异过滤思路。桌面版会补充 seek 超时、错误处理、`AbortSignal`、阶段进度和资源释放。
4. PptxGenJS 的一帧一页基本生成方式和标题元数据。桌面版必须返回 `ArrayBuffer`/`Uint8Array`，由 Main 写入用户选择的路径并验证文件，而不是在 Renderer 调用浏览器下载。
5. 视频格式诊断中的 MIME/扩展名映射可作为提示层参考，但“支持”必须由实际解码能力或 ffprobe 结果确认。

## 不能原样复用的部分

- `convertToMp4` 把完整输入和输出同时放入 JS/wasm 内存；对数 GB 课堂视频不可接受。桌面版对 HLS/容器转换使用封装的本机 ffmpeg 流程，并限制并发。
- FFmpeg core 从公共 CDN 动态加载，不适合可离线打包的 Windows 应用，也增加供应链和网络失败点。
- `extractFramesFromVideo` 直接覆盖 `video.onseeked`，没有 seek 超时、取消或解码错误路径。
- 截图 object URL 在正常流程中没有逐一 revoke，长视频会积累内存。
- `processVideoWithWebAV` 的“每 10 帧一个 scene”不是场景识别，不能当作课堂幻灯片切换算法。
- 固定 3 秒采样、最多 256 张和连续无变化提前停止必须变成选项；提前停止对长时间静态后再次切换的课程尤其危险。
- `createAndDownloadPPT` 的 `sortByImportance` 参数未使用，输出路径也不可由调用者控制。
- 上游没有验证写出的 PPTX 是否存在、非空或 ZIP 结构有效，也没有任务级清理保证。

## 桌面集成设计

`packages/video-to-ppt-core` 将保持 Renderer 运行时模型，不把浏览器算法强行改写到 Electron Main：

```text
Job orchestrator (Main)
  → 为本地视频注册只读、支持 Range 的内部媒体 URL
  → Conversion Renderer
      → HTMLVideoElement / WebAV 解码
      → 动态阈值与差异过滤
      → JPEG frame（按生成顺序及时落盘/释放）
      → PptxGenJS 生成二进制
  → Main 流式/原子写入目标 .pptx
  → 验证存在、size > 0、ZIP/PPTX 基本结构
  → 清理帧与临时视频
```

Renderer 继续保持 `contextIsolation: true`、`nodeIntegration: false`。Main 只通过窄 IPC 接收进度、帧落盘请求和最终 PPT 二进制。转换并发固定为 1。

建议的 core API 与用户目标一致，但输入不要求构造整文件 Blob：

```ts
interface ConversionOptions {
  title?: string;
  maxSlides?: number;
  threshold?: number;
  captureIntervalSeconds?: number;
}

async function convertVideoToPpt(
  input: VideoInput,
  outputPath: string,
  options: ConversionOptions,
  onProgress?: (progress: ConversionProgress) => void,
): Promise<ConversionResult>;
```

其中 `VideoInput` 会优先表示可 seek 的内部媒体 URL/文件句柄，而不是必须常驻内存的 Blob。

## Phase 6 前必须补做的验证

- 选择一段可公开测试的本地 MP4，验证动态阈值、关键帧数量和取消行为。
- 用 1 小时以上视频测量峰值内存，确认不会复制完整源视频。
- 验证 PptxGenJS 生成的 ZIP、`[Content_Types].xml`、`ppt/presentation.xml` 和 slide 数量。
- 在打包后的 Electron 中确认 WebCodecs/WebAV、内部 Range 媒体协议和 sandbox 兼容性。
- 对非 MP4、损坏视频、可变帧率、无视频轨、超长静态片段分别建立 fixture/集成测试。

## Phase 6/7 实际验证记录（2026-08-20）

- 输入为经过登录授权下载的真实课堂 MP4：H.264/AVC、1920×1080、约 3600 秒、含音频，文件大小 1,000,882,855 字节。
- 为先验证调用链，转换范围限制为前 180 秒，每 3 秒采样，最多保留 20 张有效关键帧。
- Conversion Renderer 通过只读 `xjtu-media://` 内部协议按 Range 读取文件；Renderer 未获得文件系统路径或 Node 权限。
- PptxGenJS 返回二进制后，Main 先写入 `.part`，校验 `[Content_Types].xml`、`ppt/presentation.xml` 和 slide XML，再原子重命名为 `.pptx`。
- 结果 PPTX 为 6,525,812 字节，共 21 页（1 页标题 + 20 页关键帧），结构校验通过。
- Phase 7 再次转换时，日志顺序确认为 `[PPT] generated and verified` 后 `[CLEANUP] source video deleted`；只有最终 PPTX 大小和 ZIP/PPTX 结构均有效后，才删除 1,000,882,855 字节临时视频。
- 自动清理后任务元数据状态为 `cleaned`；源视频不存在。失败或取消路径仍保留源视频。

本次验证证明真实 MP4 → 关键帧 → PPTX → 校验 → 清理的主链路可运行。它尚不等于完整一小时课堂的性能验证；全片内存峰值、耗时和关键帧质量仍需在 Phase 7 后续验证中记录。

> 2026-08-27 更新：产品输出已改为 PDF + TXT。上述 PPTX 仍由原算法生成，但只保存在任务临时目录，随后由 LibreOffice 转为 PDF、由 RapidOCR 从其中的关键帧图片生成 TXT；两个最终文件验证成功后中间 PPTX 才会删除。

## Phase 7 完整课堂验证（2026-08-20）

- 统一任务按钮从零启动，依次经过登录会话确认、视频地址解析、1,000,394,465 字节授权 MP4 下载、全片分析、关键帧提取、PPTX 写入校验和自动清理。
- 输入课堂约 50 分钟；未设置 `endTimeSeconds`，按 3 秒间隔扫描完整媒体，日志中的 Range 请求覆盖到文件尾部。
- 本次内容差异过滤保留 12 张有效关键帧；结果含标题页共 13 页，文件大小 3,546,093 字节。
- 最终 PPTX 的 `[Content_Types].xml`、`ppt/presentation.xml` 与 13 个 slide XML 均存在。
- `[PPT] generated and verified` 之后才出现 `[CLEANUP] source video deleted`，随后 `[JOB] ... pipeline completed`；任务元数据为 `cleaned`，`source.mp4` 已不存在。

因此 Phase 7 的完整课堂主链路已经真实验证，不再仅限于前三分钟样本。后续性能优化仍可继续，但不影响该流程的正确性结论。
