# Windows 发布说明

## 生成产物

在仓库根目录运行：

```powershell
corepack pnpm package:win
```

该命令先执行 Electron 生产构建，再生成 Windows x64 的两种产物：

- `XJTU Lecture2PPT-<version>-x64-Setup.exe`
- `XJTU Lecture2PPT-<version>-x64-Portable.exe`

产物位于仓库的 `release/` 目录，该目录不会提交 Git。

## 发布前检查

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm format:check
corepack pnpm build
corepack pnpm package:win
```

随后在一台没有 Node.js 的 Windows 测试机上检查：

1. 安装程序可以选择目录并创建快捷方式。
2. Portable 版本可以直接启动。
3. 西交登录窗口可以完成用户交互认证。
4. 重启后有效 Session 可以复用。
5. 课程、课堂和所有真实视频视角可以加载。
6. 生成后能在按课程分组的 PPT Library 中找到同名 PDF/TXT 文件对，且输出目录中没有最终 PPTX。
7. 安装包内包含 `document-tools/rapidocr` 和完整的 `document-tools/libreoffice`，并保留两者的许可证与 attribution。
8. 任务失败时可以重新处理或手动删除临时文件。

## 签名

当前开发构建没有配置代码签名证书，因此 Windows SmartScreen 可能显示未知发布者。正式公开分发前应使用受信任的 Windows 代码签名证书，并通过 electron-builder 的环境变量或 CI secret 注入，不得把证书和密码提交到仓库。
