# dsh-screenshot

独立截图插件，为 DeepSeek Harness（dsh）提供屏幕捕获能力。**不是 modlens 的替代品**——它是从 @liustack/modlens 的 dsh 插件中拆分出来的独立包（该功能上游未采纳，见 [liustack/modlens#48](https://github.com/liustack/modlens/issues/48)），目的是让截图功能**不随 modlens 更新而被覆盖**。

## 使用说明

视频教程（B 站）：[用 DeepSeek Harness 给 DeepSeek Harness 写了个 Dsh screenshot 插件](https://www.bilibili.com/video/BV1bF8G6oE66/)

## 致谢

本插件的截图能力最初是作为 [@liustack/modlens](https://github.com/liustack/modlens)（作者 Leon Liu）的 dsh 插件增强实现的。**衷心感谢原作者为 DSH 提供了识图能力**——modlens 让纯文本模型（DeepSeek/GLM）能够"看见"图片，本插件的 `modlens_screenshot` 工具正是复用 modlens 的识图管线，把"截屏 + 识图"合成一步。截图功能本身从 modlens 中拆分出来独立维护，但识图能力始终归功于 modlens 项目。

## 能力

- **浏览器热键**（在 dsh 网页中）：
  - `Ctrl+Alt+S` — 区域截图（弹出选择框，鼠标左键在桌面空白处按下开始，拖拽选框，Esc 取消）
  - `Ctrl+Shift+Alt+S` — 全屏截图（无交互，直接捕获整个虚拟桌面）
- **Agent 工具**：`modlens_screenshot` — AI 可自主截屏并识图（若本机装有 modlens CLI）
- **Edge 风格选区**：区域截图时，全屏清晰原图 + 41% 暗化遮罩；拖动选区时选区内恢复清晰原图，选区外保持暗化——方便判断截取范围
- 截图 PNG 保存到 `%USERPROFILE%\Downloads\modlens-screenshots\`，路径自动插入 DSH 输入框
- **路径复制到剪贴板**：截图完成后，PNG 路径会同时自动复制到剪贴板，可粘贴到任何支持图片的智能体（DSH、CodeBuddy、Claude Code 等）
- 激活截图后桌面保持 live，可拖动窗口排版，点桌面空白处或横幅触发——不依赖 dsh 页面

## 为什么只传路径，不传图片？

截图保存到 `%USERPROFILE%\Downloads\modlens-screenshots\`（独立、易清理的目录），**只把 PNG 路径传给智能体**，而不是把图片本身塞进对话框或临时目录。这是刻意的设计：

- **防止图片垃圾**：很多智能体框架粘贴图片时，会把图片复制到自己的临时/附件目录，日积月累产生大量无法追踪的垃圾文件。只传路径，图片只存在一个地方（`modlens-screenshots/`），清理就是删一个目录。
- **路径通用**：任何支持图片的智能体（原生多模态模型，或 modlens 类桥接）都能通过路径读取图片——路径是通用的，图片格式不是。
- **不污染上下文**：路径是几十字节的文本，图片是几百 KB 的二进制——传路径让上下文干净、可追溯。

这个设计让"截图 → 智能体读图"的工作流更干净：截图一次，路径可复用到任何智能体，且不产生任何垃圾。

## 与 modlens 的关系

| 层面 | 依赖 modlens？ | 说明 |
|---|---|---|
| 截图动作 | **否** | 纯 PowerShell `CopyFromScreen`，零依赖 |
| 浏览器热键 / 路径插入 | **否** | 独立路由 `/dsh-screenshot/screenshot` |
| `modlens_screenshot` 工具读图 | **是（可选）** | 若找不到 modlens CLI，工具不注册，截图照常工作 |
| 配合多模态模型 | 否 | 截图路径插入后，多模态模型（如 go-mimo）可直接看图，无需 modlens |

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @paicat1/dsh-screenshot
```

### 从市场安装

插件已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（vision 分类），可在 DSH Plugin Hub / dsh-market 中一键安装。

### 装配到 dsh profile（开发/本地）

在 dsh profile（如 `%USERPROFILE%\.dsh\profiles\web`）中：

1. 把本包加入 `package.json` 的 `dependencies`（或 pnpm workspace）
2. 在 `package.json` 的 `dsh.profile.bundles` 中加入本包名
3. 重启 dsh 服务并刷新页面

## 配置

可在 cordis 配置中传参（可选，默认全部开启）：

- `route: false` — 关闭浏览器截图路由
- `tool: false` — 关闭 `modlens_screenshot` 工具

环境变量 `MODLENS_DSH_CLI` 可显式指定 modlens CLI 路径（默认探测
`~/.dsh/profiles/{web,headless}/node_modules/@liustack/modlens/dist/main.js`）。

## 平台与许可证

- **平台**：Windows（依赖 PowerShell `System.Drawing.CopyFromScreen`）
- **许可证**：MIT

## 背景

原 modlens 的 dsh 插件集成了截图能力（本仓库 fork 的 `feat/dsh-screenshot` 分支），
作者在 [issue #48](https://github.com/liustack/modlens/issues/48) 中标记为 not planned。
为解耦 modlens 更新对截图功能的影响，将其拆分为本独立插件。