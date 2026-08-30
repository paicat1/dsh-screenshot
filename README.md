# dsh-screenshot

[English](README.en.md) | [中文](README.md)

**DSH 轻量截图插件**：**轻**：零依赖零二进制；**摆**：一键全屏、窗口排版、悬停吸附截取被遮挡窗口；**自助**：Agent 可自助截屏，传路径不传图，路径通用，接上 modlens（选装）一步读出结构化内容。

- **轻** — 纯 PowerShell 实现，零依赖、零二进制；截图能力独立维护，不随任何上游更新而失效。
- **摆** — 一键全屏即拍；框选前整个桌面保持可操作，所有窗口像布置画面一样自由移动、缩放；**鼠标悬停任意窗口即亮起吸附边框，点一下直接截该窗口——被遮挡也能拿到完整内容**（传统控制台窗口除外，见下）——所得即所见。
- **自助** — Agent 可随时自行截屏；接上 modlens（选装），截屏 + 识图一步产出结构化内容（OCR/版面/语义），纯文本模型也能消费。

## 快速开始

```sh
dsh plugin --profile web add @paicat1/dsh-screenshot
# 重启 dsh web
```

- `Ctrl+Alt+S` — 截图：进入选取后，**点一下桌面 = 全屏**；**鼠标悬停窗口会亮起吸附边框，点一下 = 截该窗口完整内容（被遮挡也一样，传统控制台窗口除外）**；**拖拽 = 自由选区**（Esc 取消）
- `Ctrl+Shift+Alt+S` — 全屏截图：无交互，直接捕获整个虚拟桌面
- 想让 Agent 自己截屏？直接告诉它用 `modlens_screenshot` 工具即可

视频教程（B 站）：[用 DeepSeek Harness 给 DeepSeek Harness 写了个 Dsh screenshot 插件](https://www.bilibili.com/video/BV1bF8G6oE66/)

## 双通道：人按热键，Agent 用工具

| 入口 | 适合 | 说明 |
|---|---|---|
| 浏览器热键（人） | "我想给你看这块屏幕" | 全屏 / 框选；截图后 PNG 路径自动插入 DSH 输入框，并复制到剪贴板 |
| `modlens_screenshot` 工具（Agent） | "我自己看一下屏幕" | 模型自主调用：截屏 +（modlens 在场时）当场读出结构化内容，返回证据 + 截图路径 |

| 人工操作演示 | Agent 自助调用演示 |
|---|---|
| ![人工操作演示](assets/demo-manual.gif) | ![Agent 自助调用演示](assets/demo-agent.gif) |

## 为什么传路径，不传图？

截图保存到 `%USERPROFILE%\Downloads\modlens-screenshots\`（独立、易清理的目录），**只把 PNG 路径传给智能体**，而不是把图片本身塞进对话框或临时目录。这是刻意的设计：

- **不产生图片垃圾**：很多智能体框架粘贴图片时，会把图片复制到自己的临时/附件目录，日积月累产生大量无法追踪的垃圾文件。只传路径，图片只存在一个地方（`modlens-screenshots/`），清理就是删一个目录。
- **路径通用**：任何支持图片的智能体（原生多模态模型，或 modlens 类桥接）都能通过路径读取图片——路径是通用的，图片格式不是。
- **上下文干净**：路径是几十字节的文本，图片是几百 KB 的二进制——传路径让上下文干净、可追溯。

"截图 → 智能体读图"的工作流因此更干净：截图一次，路径可复用到任何智能体，且不产生任何垃圾。

## 能力划分：哪些是插件的，哪些是 modlens 的

| 层 | 能力 | 归属 |
|---|---|---|
| 截图 | 全屏 / 框选 / **窗口吸附截图** / 摆窗布局，PowerShell 零依赖 | 本插件 |
| 分发 | 传路径不传图、剪贴板、独立保存目录 | 本插件 |
| 入口 | 浏览器热键 + Agent 可调用的截图工具 | 本插件 |
| 读图 | OCR / 版面 / 语义 结构化证据 | modlens（选装） |
| 消费 | 谁看懂这张图 | 任意多模态模型 / 视觉桥，不挑 |

截图与分发是纯本插件能力，可独立使用；读图是生态组合能力——装上 modlens（或交给任意支持图片的模型/视觉桥）即解锁，未装时截图照常工作。

**窗口吸附为什么能截到"被挡住"的窗口？** 悬停时插件枚举屏幕上的窗口、高亮光标下的那一个；单击后通过 `PrintWindow` 让窗口**自己把内容渲染出来**——截的是窗口自身，不是屏幕上可见的像素，所以被其他窗口遮挡、被 DWM 阴影包裹都不影响；最后按内容边界裁掉阴影，四边干净。

**已知特例：个别控制台窗口**（`ConsoleWindowClass`，由系统 conhost 渲染）。**绝大多数控制台窗口——cmd（命令提示符）、Windows PowerShell 5.1、以及跑着 `python`/`node`/`git`/批处理的窗口——`PrintWindow` 都正常，可以像普通窗口一样穿透遮挡截取完整内容**。只有**个别 conhost 实现不响应 `PrintWindow`**（实测独立运行的 **PowerShell 7 / pwsh** 就是这种），且这类窗口**后台被覆盖时不会渲染 GDI 表面**——两条"穿透遮挡"的路径都走不通。单击这类窗口会回退为截取屏幕上该区域的可见像素：无遮挡时内容完整干净，被其他窗口遮挡时会截到遮挡内容（与 Windows 自带截图工具行为一致）。**要截干净，要么先把它切到前台、移开遮挡后再单击截取，要么直接用拖拽框选截取**。

## 配置

可选 cordis 配置（默认全部开启）：

- `route: false` — 关闭浏览器截图路由
- `tool: false` — 关闭 `modlens_screenshot` 工具

环境变量 `MODLENS_DSH_CLI` 可显式指定 modlens CLI 路径（默认探测 `~/.dsh/profiles/{web,headless}/node_modules/@liustack/modlens/dist/main.js`）。

## 平台与许可证

- **平台**：Windows（依赖 PowerShell `System.Drawing.CopyFromScreen`）
- **许可证**：MIT

## 与 modlens 的关系

| 层面 | 依赖 modlens？ | 说明 |
|---|---|---|
| 截图动作 | **否** | 纯 PowerShell `CopyFromScreen`，零依赖 |
| 浏览器热键 / 路径插入 | **否** | 独立路由 `/dsh-screenshot/screenshot` |
| `modlens_screenshot` 工具读图 | **是（可选）** | 若找不到 modlens CLI，工具不注册，截图照常工作 |
| 配合多模态模型 | 否 | 截图路径插入后，多模态模型（如 go-mimo）可直接看图，无需 modlens |

## 背景与致谢

本插件的截图能力最初是作为 [@liustack/modlens](https://github.com/liustack/modlens)（作者 Leon Liu）的 dsh 插件增强实现的：原 modlens 集成过截图功能（本仓库 fork 的 `feat/dsh-screenshot` 分支），作者在 [issue #48](https://github.com/liustack/modlens/issues/48) 中标记为 not planned。为解耦 modlens 更新对截图功能的影响，将其拆分为本独立插件。

**衷心感谢原作者为 DSH 提供了识图能力**——modlens 让纯文本模型（DeepSeek/GLM）能够"看见"图片，本插件的 `modlens_screenshot` 工具正是复用 modlens 的识图管线，把"截屏 + 识图"合成一步。截图功能本身从 modlens 中拆分出来独立维护，但识图能力始终归功于 modlens 项目。
