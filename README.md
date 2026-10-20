# XJTU Lecture2PPT

XJTU Lecture2PPT 是一个 Windows 桌面应用，用于把当前登录用户有权观看的西安交通大学课堂回放整理为 PDF 课件和 OCR 文字稿。

## 已实现功能

- 在独立认证窗口中完成西交统一身份认证，不保存账号或明文密码。
- 使用持久化 Electron Session，重启后复用有效登录状态。
- 读取学期、课程、课堂回放以及服务端实际返回的全部视频视角。
- 流式下载 MP4，支持进度、取消、超时、重试和断点续传。
- 复用 `video-to-ppt` 的关键帧差异检测与 PPT 生成逻辑；PPTX 只作为任务中间文件。
- 使用开源 LibreOffice 将中间 PPTX 转为 PDF，并使用内置 RapidOCR（复用 Umi-OCR 调用与排版逻辑）生成 TXT。
- PDF 与 TXT 均验证写入成功后删除中间 PPTX，随后才按设置删除临时视频。
- 任务持久化；应用意外退出后，未完成任务会变为可恢复的失败任务。
- 任务页支持取消、重新处理和删除失败任务临时文件。
- PPT Library 按课程分组展示 PDF/TXT 文件对，支持文件名搜索、打开、定位和成对删除。
- 设置页支持默认学期、输出目录、下载并发、成功后自动清理和过期文件保留策略。
- 自动清理超过保留期限的孤立临时任务目录。

NotebookLM 不属于当前产品范围，桌面应用不包含 Google 登录或上传入口。

## 环境要求

- Windows 10/11 x64
- Node.js 22 或更高版本（仅开发需要）
- pnpm 11（可通过 Corepack 使用）

最终安装包和 portable 版本包含运行所需组件，普通用户不需要安装 Node.js 或 pnpm。

## 开发

```powershell
corepack pnpm install
corepack pnpm dev
```

首次使用时点击“登录西交”，只在打开的统一身份认证窗口中输入凭据。不要把账号、密码、Cookie 或 token 写入配置文件或提交到仓库。

## 验证

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm format:check
corepack pnpm build
```

自动测试使用 fixtures 和 mock，不依赖真实学校账号。真实登录、课程读取和课堂视频只能由有访问权限的用户在本机验证。

## Windows 打包

```powershell
corepack pnpm package:win
```

产物写入 `release/`：

- NSIS 安装程序：允许选择安装目录并创建桌面/开始菜单快捷方式。
- Portable 可执行文件：无需安装即可运行。

详细说明见 [Windows 发布说明](docs/windows-release.md)。

## 本机数据位置

- 设置、加密 Session 和日志：Electron `userData` 目录。
- 临时视频：`userData/temp/jobs/<job-id>/source.mp4`。
- 默认 PDF/TXT：`文档/XJTU Lecture2PPT/`。
- 任务记录：`userData/state/pipeline-jobs.json`。

失败任务默认保留临时视频和可能存在的中间 PPTX，便于重新处理。只有 PDF 与 TXT 都确认写入成功，或用户明确点击“删除临时文件”后，应用才会删除视频。

## 当前媒体限制

已实际确认的西交课堂媒体为普通 MP4，当前下载器正式支持该路径。遇到 HLS、DASH 或未知流类型时应用会明确报错，不会猜测接口或尝试绕过 DRM。

## 安全与隐私

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- 日志统一调用 `redactSecrets()`，Cookie、Authorization、ticket、token 和签名查询参数会被脱敏。
- `.dev-session/`、`.har/`、`.network-logs/`、`temp/` 和 `downloads/` 已加入 `.gitignore`。
- 软件不绕过统一身份认证、验证码、MFA、访问控制或 DRM。

## 上游项目

关键帧提取和中间 PPT 生成逻辑来源于 `liwenka1/video-to-ppt`。离线 OCR 进程协议和文字排版逻辑来源于 hiroi-sora 的 Umi-OCR/RapidOCR-json；PDF 转换调用方式来自 `libreoffice-convert`，实际转换引擎为 LibreOffice。许可证与 attribution 位于 `packages/video-to-ppt-core/`、`packages/document-exporter/` 和 `third_party/runtime/rapidocr/`。

## 文档转换引擎

- RapidOCR-json 已放入 `third_party/runtime/rapidocr/`，Windows 打包时会自动复制到应用资源目录，不需要用户启动 Umi-OCR。
- 开发环境会从 `LIBRE_OFFICE_EXE`、LibreOffice 标准安装位置或 `PATH` 查找 `soffice`。
- Windows 安装包会把完整 LibreOffice 运行时复制到 `resources/document-tools/libreoffice/`，应用优先使用内置引擎；开发环境仍可从环境变量、标准安装位置或 `PATH` 查找。
- OCR 全程离线运行；课堂图片不会发送到第三方服务器。
