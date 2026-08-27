# dsh-screenshot

A standalone screen capture plugin for DeepSeek Harness (dsh). **Not a replacement for modlens** — it was split out of the dsh plugin in @liustack/modlens as a standalone package (the feature was declined upstream, see [liustack/modlens#48](https://github.com/liustack/modlens/issues/48)), so the capture capability is **not overwritten by modlens updates**.

## Usage

Video tutorial (Bilibili): [Using DeepSeek Harness to build a Dsh screenshot plugin for DeepSeek Harness](https://www.bilibili.com/video/BV1bF8G6oE66/)

## Credits

The capture capability was originally implemented as an enhancement to the dsh plugin of [@liustack/modlens](https://github.com/liustack/modlens) (by Leon Liu). **Many thanks to the original author for giving DSH image-reading ability** — modlens lets text-only models (DeepSeek/GLM) "see" images, and this plugin's `modlens_screenshot` tool reuses the modlens pipeline to combine "capture + read" into one step. The capture half is maintained separately, but the image-reading ability always belongs to the modlens project.

## Features

- **Browser hotkeys** (inside the dsh web UI):
  - `Ctrl+Alt+S` — region capture (selection overlay; press and drag with the left mouse button on empty desktop, Esc to cancel)
  - `Ctrl+Shift+Alt+S` — full-screen capture (no interaction, captures the whole virtual desktop)
- **Agent tool**: `modlens_screenshot` — the AI can capture and read the screen autonomously (if the modlens CLI is installed)
- **Edge-style selection**: during region capture, the full screen stays sharp with a 41% dim overlay; while dragging, the selection reveals a clear window of the original image while the rest stays dimmed — easy to judge the capture area
- PNGs are saved to `%USERPROFILE%\Downloads\modlens-screenshots\` and the path is auto-inserted into the DSH input box
- **Path copied to clipboard**: after capture, the PNG path is also automatically copied to the clipboard, ready to paste into any image-capable agent (DSH, CodeBuddy, Claude Code, etc.)
- The desktop stays live after activation — you can arrange windows and trigger capture by clicking empty desktop or the hint banner, without depending on the dsh page

## Why pass the path, not the image?

Screenshots are saved to `%USERPROFILE%\Downloads\modlens-screenshots\` (a dedicated, easy-to-clean directory), and **only the PNG path is handed to the agent** — not the image itself stuffed into a chat box or temp directory. This is a deliberate design:

- **No image litter**: many agent frameworks copy pasted images into their own temp/attachment directories, accumulating untrackable junk over time. Passing the path keeps the image in exactly one place (`modlens-screenshots/`); cleaning up is deleting one directory.
- **Path is universal**: any image-capable agent (native multimodal models, or modlens-style bridges) can read an image from a path — paths are universal, image formats are not.
- **Clean context**: a path is tens of bytes of text; an image is hundreds of KB of binary. Passing the path keeps the context clean and traceable.

This design makes the "capture → agent reads image" workflow cleaner: capture once, reuse the path in any agent, and produce zero junk.

## Relationship with modlens

| Layer | Depends on modlens? | Notes |
|---|---|---|
| Capture action | **No** | Pure PowerShell `CopyFromScreen`, zero dependencies |
| Browser hotkeys / path insert | **No** | Standalone route `/dsh-screenshot/screenshot` |
| `modlens_screenshot` tool reading | **Yes (optional)** | If the modlens CLI is missing, the tool is not registered; capture still works |
| Multimodal models | No | After the path is inserted, multimodal models (e.g. go-mimo) can read the image directly, no modlens needed |

## Installation

### From npm (recommended)

```bash
dsh plugin --profile web add @paicat1/dsh-screenshot
```

### From the marketplace

The plugin is listed in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (vision category) and can be installed with one click from DSH Plugin Hub / dsh-market.

### Assemble into a dsh profile (development/local)

In a dsh profile (e.g. `%USERPROFILE%\.dsh\profiles\web`):

1. Add this package to `package.json` `dependencies` (or pnpm workspace)
2. Add this package name to `dsh.profile.bundles` in `package.json`
3. Restart the dsh service and refresh the page

## Configuration

Optional cordis config (all enabled by default):

- `route: false` — disable the browser capture route
- `tool: false` — disable the `modlens_screenshot` tool

The `MODLENS_DSH_CLI` environment variable explicitly sets the modlens CLI path (default probe:
`~/.dsh/profiles/{web,headless}/node_modules/@liustack/modlens/dist/main.js`).

## Platform & License

- **Platform**: Windows (relies on PowerShell `System.Drawing.CopyFromScreen`)
- **License**: MIT

## Background

The original modlens dsh plugin integrated capture (this repo's fork of the `feat/dsh-screenshot` branch); the author marked it as not planned in [issue #48](https://github.com/liustack/modlens/issues/48). It was split into this standalone plugin to decouple capture from modlens updates.