# Google 登录方案调研

调研日期：2026-08-20

## 结论

个人版 NotebookLM 没有在本项目中确认到可供正式客户端使用的公开 API。正式实现继续采用浏览器适配器，但不得绕过 Google MFA、CAPTCHA 或自动化检测。

Google 已于 2026-07-16 将 NotebookLM 更名为 Gemini Notebook。本机真实访问先后观察到 `https://notebook.google/`，登录成功后最终产品域名为 `https://notebook.google.com/`；旧入口 `https://notebooklm.google.com/` 仍可访问。Inspector 优先真实登录后的最终入口，并兼容另外两个已观察域名。

Playwright 直接启动 Edge 时会注入一组自动化参数。在本机实测中，即使精确移除 `--no-sandbox`，Google 仍拒绝登录。因此 Inspector 已改为 Microsoft 官方 Edge DevTools Protocol 路线：程序直接启动正常 Edge，只传入独立 Profile、环回调试端口和 NotebookLM 地址，然后 Playwright 通过公开的 `connectOverCDP` API 附加。该路径不传入 `--no-sandbox`、`--enable-automation`、stealth 参数，也不复制或解密日常 Edge Profile/Cookie。

Inspector 启动后会在临时页面执行一段本地脚本，真实验证 JavaScript 是否运行；同时检查独立 Profile 中 Google 域名不存在 JavaScript 阻止规则。独立 Profile 位于 `.dev-session/notebooklm-inspector-edge-cdp/`，继续由 Git 忽略。

## 已审查的 GitHub 项目

### 可正式参考

- `googleapis/google-auth-library-nodejs`：Google 官方 Node.js OAuth 2.0 客户端。适合 NotebookLM Enterprise 或其他有公开 Google API 的模块；不能把 OAuth access token 当作个人 NotebookLM 网页 Cookie。
- `microsoft/playwright`：官方支持 Microsoft Edge channel、持久化 Profile、`chromiumSandbox` 和 `connectOverCDP`。本项目 BrowserAdapter 继续建立在该项目的公开 API 上。

### 仅研究，不作为正式依赖

- `teng-lin/notebooklm-py`：提供持久 Chromium Profile，也提供浏览器 Cookie 和 master token 方案。后两者会扩大凭据暴露面，并依赖非公开 NotebookLM 行为，本项目不采用。
- `tmc/nlm`：可从 Chrome/Brave/Edge 提取登录凭据并调用 NotebookLM 协议。该路线不符合本项目“浏览器自动化优先、不得依赖未经验证私有 RPC”的原则，不采用。
- `reallygood83/notebooklm-cli`：同样基于浏览器 Cookie 和非公开 NotebookLM 行为，只用于对比登录持久化思路。

## 安全边界

- 不读取普通 Edge Profile 的 Cookie 数据库。
- 不保存 Google 密码、验证码、Passkey 或 MFA 信息。
- 不使用 stealth patch、CAPTCHA 绕过或 master token。
- 独立 Profile 位于 `.dev-session/`，已经被 Git 忽略。
- 观察日志继续脱敏 Notebook ID、标题、账号和 URL query。

## 参考

- https://github.com/googleapis/google-auth-library-nodejs
- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsertype.md
- https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md
- https://github.com/microsoft/playwright.dev/blob/main/mcp/configuration/browser-extension.mdx
- https://github.com/teng-lin/notebooklm-py
- https://github.com/tmc/nlm
- https://github.com/reallygood83/notebooklm-cli
