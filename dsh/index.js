// dsh-screenshot: standalone screen-capture plugin for DeepSeek Harness.
// Forked out of the @liustack/modlens dsh plugin (which upstream declined:
// liustack/modlens#48). Provides the capture the browser hotkeys use and the
// agent-facing modlens_screenshot tool. The capture itself is dependency-free
// (PowerShell CopyFromScreen); reading the shot through modlens is optional
// and resolved against an installed modlens CLI.
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Resolve the modlens CLI used to read a captured shot. MODLENS_DSH_CLI wins;
// otherwise probe the common install locations. If none is found the capture
// route and hotkeys still work (a path is produced); only the tool's read step
// fails, with a clear message.
function resolveCliPath() {
  if (process.env.MODLENS_DSH_CLI) return process.env.MODLENS_DSH_CLI
  const homes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean)
  const profiles = ['web', 'headless']
  for (const home of homes) {
    for (const profile of profiles) {
      const p = path.join(home, '.dsh', 'profiles', profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js')
      try { if (statSync(p).isFile()) return p } catch {}
    }
  }
  return null
}

const CLI_PATH = resolveCliPath()
const CLI_TIMEOUT_MS = 180_000

export const name = 'dsh-screenshot'
export const inject = ['tools', 'webServer']

const OUTPUT_SCHEMA = JSON.parse(readFileSync(new URL('./vision-schema.json', import.meta.url), 'utf8'))
const CAPTURE_TIMEOUT_MS = 600_000 // region mode waits on the user

// User-visible capture strings, as short bundles (en/zh) - the same
// convention the modlens client uses for its labels. The host resolves the
// locale from config.locale, then the DSH_SCREENSHOT_LANG environment
// variable, then the Node ICU default (which follows the OS UI language),
// defaulting to en. The browser half resolves its own from the document lang.
const UI = {
  en: {
    bannerText: 'Click the desktop background to capture · drag windows to arrange · Esc to cancel',
    bannerHint: 'Esc to cancel',
  },
  zh: {
    bannerText: '点击桌面空白处开始截图 · 点击窗口可排版 · Esc 取消',
    bannerHint: 'Esc 取消',
  },
}

let ui = UI.en

function resolveUi(config = {}) {
  const lang = String(
    config.locale ||
      process.env.DSH_SCREENSHOT_LANG ||
      (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '') ||
      'en',
  ).toLowerCase()
  ui = lang.indexOf('zh') === 0 ? UI.zh : UI.en
  return ui
}

const CAPTURE_SCRIPT = (ui) => `param(
    [Parameter(Mandatory=$true)][string]$OutPath,
    [string]$Mode = 'region'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class MLDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue
    [MLDpi]::SetProcessDPIAware() | Out-Null
} catch { }

# Force the overlay above everything (including topmost windows like a fullscreen browser).
Add-Type -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public static class MLTop {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
}

// Global low-level hooks. While the pill shows, the desktop stays FULLY LIVE
// (windows draggable): a press on a real window passes through untouched, and
// only a press on the DESKTOP BACKGROUND (Progman/WorkerW/SHELLDLL_DefView) or
// on the pill itself (a WindowsForms window) is swallowed and becomes the
// capture trigger. Esc (global keyboard hook) cancels from anywhere.
// Install uses GetModuleHandle(null) - the exe module - which is the reliable
// way for low-level hooks (a MainModule.ModuleName lookup can return a name
// GetModuleHandle cannot match, and SetWindowsHookEx then fails with 1428).
public static class MLHooks {
    public delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point pt);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    public const uint GA_PARENT = 1;
    public const int WH_MOUSE_LL = 14;
    public const int WH_KEYBOARD_LL = 13;
    public const int WM_LBUTTONDOWN = 0x0201;
    public const int WM_RBUTTONDOWN = 0x0204;
    public const int WM_KEYDOWN = 0x0100;
    public const int VK_ESCAPE = 0x1B;
    public const int VK_LBUTTON = 0x01;
    public static LowLevelProc MouseProc = MouseCallback;
    public static LowLevelProc KeyProc = KeyCallback;
    public static IntPtr MouseHook = IntPtr.Zero;
    public static IntPtr KeyHook = IntPtr.Zero;
    public static bool Armed = false;
    public static int LastError = 0;
    public static int TriggerButton = 0;   // 0 = none, 1 = left, 2 = right
    public static int ClickX = 0;
    public static int ClickY = 0;
    public static bool CancelRequested = false;
    public static string ClassOf(IntPtr hwnd) {
        var sb = new System.Text.StringBuilder(256);
        GetClassName(hwnd, sb, 256);
        return sb.ToString();
    }
    private static bool IsDesktopClass(string cls) {
        return cls == "Progman" || cls == "WorkerW" || cls == "SHELLDLL_DefView";
    }
    // WindowFromPoint returns the DEEPEST child window: a click on desktop
    // blank space usually lands on the icon list (SysListView32) whose PARENT
    // chain walks up to SHELLDLL_DefView/Progman. So walk the parent chain
    // (bounded) instead of comparing only the hit window class. An Explorer
    // own list view (CabinetWClass chain) never reaches a desktop class, so
    // real window interaction still passes through. The pill itself is a
    // top-level WindowsForms window and matches directly.
    public static bool IsDesktopOrPill(IntPtr hwnd) {
        string cls = ClassOf(hwnd);
        if (cls.StartsWith("WindowsForms")) return true;
        IntPtr cur = hwnd;
        for (int i = 0; i < 10 && cur != IntPtr.Zero; i++) {
            if (IsDesktopClass(ClassOf(cur))) return true;
            cur = GetAncestor(cur, GA_PARENT);
        }
        return false;
    }
    public static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && Armed) {
            int msg = (int)wParam;
            if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN) {
                int x = Marshal.ReadInt32(lParam, 0);
                int y = Marshal.ReadInt32(lParam, 4);
                // Desktop background (direct or via the icon list parent
                // chain) or our own pill: the capture trigger. Swallow it so
                // the desktop gets no click and no context menu. Everything
                // else passes through (never swallow real window interaction).
                if (IsDesktopOrPill(WindowFromPoint(new System.Drawing.Point(x, y)))) {
                    TriggerButton = msg == WM_LBUTTONDOWN ? 1 : 2;
                    ClickX = x; ClickY = y;
                    return new IntPtr(1);
                }
            }
        }
        return CallNextHookEx(MouseHook, nCode, wParam, lParam);
    }
    public static IntPtr KeyCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (int)wParam == WM_KEYDOWN) {
            if (Marshal.ReadInt32(lParam) == VK_ESCAPE) CancelRequested = true;
        }
        return CallNextHookEx(KeyHook, nCode, wParam, lParam);
    }
    public static void Install() {
        IntPtr hMod = GetModuleHandle(null);
        MouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, hMod, 0);
        KeyHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyProc, hMod, 0);
        if (MouseHook == IntPtr.Zero || KeyHook == IntPtr.Zero) {
            LastError = Marshal.GetLastWin32Error();
            if (MouseHook != IntPtr.Zero) { UnhookWindowsHookEx(MouseHook); MouseHook = IntPtr.Zero; }
            if (KeyHook != IntPtr.Zero) { UnhookWindowsHookEx(KeyHook); KeyHook = IntPtr.Zero; }
        }
        Armed = (MouseHook != IntPtr.Zero);
    }
    public static void UninstallMouse() {
        Armed = false;
        if (MouseHook != IntPtr.Zero) { UnhookWindowsHookEx(MouseHook); MouseHook = IntPtr.Zero; }
    }
    public static void UninstallKeys() {
        if (KeyHook != IntPtr.Zero) { UnhookWindowsHookEx(KeyHook); KeyHook = IntPtr.Zero; }
    }
    public static bool LeftButtonDown() {
        return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
    }
}' -ErrorAction SilentlyContinue

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$width = $screen.Width
$height = $screen.Height

# ── full mode: capture immediately, no interaction ──
if ($Mode -eq 'full') {
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    exit 0
}

# ── region mode: arrange-then-capture. Activation shows only a hint pill and
# leaves the desktop FULLY LIVE (windows stay draggable - the user can arrange
# and even switch away from the DSH page). A global low-level mouse hook
# swallows a press on the DESKTOP BACKGROUND or on the pill; that press is the
# trigger - CopyFromScreen grabs the CURRENT layout immediately, then a frosted
# overlay shows the sharp original inside the drag selection. Presses on real
# windows pass through untouched so arranging keeps working. Esc (global
# keyboard hook or pill) cancels; a 5-minute idle timer auto-cancels.
$bannerText = '${ui.bannerText}'
$bannerHint = '${ui.bannerHint}'
$bannerFont = New-Object System.Drawing.Font('Microsoft YaHei', 17)
$hintFont = New-Object System.Drawing.Font('Microsoft YaHei', 13)
$tempBmp = New-Object System.Drawing.Bitmap(4, 4)
$tempG = [System.Drawing.Graphics]::FromImage($tempBmp)
$textW = [System.Windows.Forms.TextRenderer]::MeasureText($tempG, $bannerText, $bannerFont).Width
$hintW = [System.Windows.Forms.TextRenderer]::MeasureText($tempG, $bannerHint, $hintFont).Width
$tempG.Dispose()
$tempBmp.Dispose()
$bannerW = [int](28 + $textW + 22 + $hintW + 28)
$bannerH = 78

# Hint pill: white rounded rect. Clickable as a fallback trigger (the hook
# normally swallows pill presses and fires itself).
$banner = New-Object System.Windows.Forms.Form
$banner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$banner.TopMost = $true
$banner.ShowInTaskbar = $false
$banner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$banner.BackColor = [System.Drawing.Color]::White
$banner.KeyPreview = $true
$banner.SetBounds(($screen.X + ($width - $bannerW) / 2), ($screen.Y + 16), $bannerW, $bannerH)

$cornerPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 12
$cornerPath.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$cornerPath.AddArc(($bannerW - $radius * 2), 0, $radius * 2, $radius * 2, 270, 90)
$cornerPath.AddArc(($bannerW - $radius * 2), ($bannerH - $radius * 2), $radius * 2, $radius * 2, 0, 90)
$cornerPath.AddArc(0, ($bannerH - $radius * 2), $radius * 2, $radius * 2, 90, 90)
$cornerPath.CloseFigure()
$banner.Region = New-Object System.Drawing.Region($cornerPath)

$banner.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::White)
    $border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 150, 150, 150))
    $border.Width = 2
    $g.DrawRectangle($border, 1, 1, $banner.Width - 3, $banner.Height - 3)
    $border.Dispose()
})

$bannerLabel = New-Object System.Windows.Forms.Label
$bannerLabel.Text = $bannerText
$bannerLabel.Font = $bannerFont
$bannerLabel.ForeColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$bannerLabel.SetBounds(28, 16, ($textW + 8), 46)
$bannerLabel.AutoSize = $false
$banner.Controls.Add($bannerLabel)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Text = $bannerHint
$hintLabel.Font = $hintFont
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
$hintLabel.SetBounds((28 + $textW + 22), 18, $hintW, 42)
$hintLabel.AutoSize = $false
$hintLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$banner.Controls.Add($hintLabel)

$banner.Add_KeyDown({
    param($sender, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $script:pillTrigger = -1
        $banner.Close()
    }
})
# Fallback trigger when the mouse hook is unavailable: clicking the pill.
$banner.Add_MouseClick({
    param($sender, $e)
    if (($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -or $e.Button -eq [System.Windows.Forms.MouseButtons]::Right) -and $script:pillTrigger -eq 0) {
        $script:pillTrigger = if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) { 2 } else { 1 }
        $script:clickX = $banner.Left + $e.X
        $script:clickY = $banner.Top + $e.Y
        $banner.Close()
    }
})
$banner.Add_Shown({
    param($sender, $e)
    try { [MLTop]::SetWindowPos($banner.Handle, (New-Object IntPtr -ArgumentList (-1)), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null } catch { }
})

$script:pillTrigger = 0
$script:clickX = 0
$script:clickY = 0

# Install the global hooks. If they fail, keep going with the pill fallback
# and write the reason to stderr so the host log shows it.
[MLHooks]::Install()
if (-not [MLHooks]::Armed) {
    [Console]::Error.WriteLine('[modlens] global mouse hook failed (err ' + [MLHooks]::LastError + '), using pill click as the only trigger')
}

# Poll the hook flags while the pill modal loop runs.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$script:ticks = 0
$timer.Add_Tick({
    $script:ticks++
    if ([MLHooks]::CancelRequested) {
        $script:pillTrigger = -1
        $banner.Close()
    } elseif ([MLHooks]::TriggerButton -ne 0 -and $script:pillTrigger -eq 0) {
        $script:pillTrigger = [MLHooks]::TriggerButton
        $script:clickX = [MLHooks]::ClickX
        $script:clickY = [MLHooks]::ClickY
        $banner.Close()
    } elseif ($script:ticks -gt 3000 -and $script:pillTrigger -eq 0) {
        # 5 minute idle safety net: auto-cancel instead of hanging forever.
        $script:pillTrigger = -1
        $banner.Close()
    }
})
$timer.Start()
$banner.ShowDialog()
$timer.Stop()
$timer.Dispose()
$banner.Dispose()

$tb = $script:pillTrigger
$cx = $script:clickX
$cy = $script:clickY
[MLHooks]::UninstallMouse()
if ($tb -le 0) { [MLHooks]::UninstallKeys(); exit 2 }

# ── capture NOW (the arranged layout), then select on a frosted overlay ──
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [MLHooks]::UninstallKeys()
    exit 1
}

$script:blurFull = $null
try {
    $blurW = [Math]::Max(1, [int]($width / 12))
    $blurH = [Math]::Max(1, [int]($height / 12))
    $blurSmall = New-Object System.Drawing.Bitmap($blurW, $blurH)
    $blurG = [System.Drawing.Graphics]::FromImage($blurSmall)
    $blurG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $blurG.DrawImage($bmp, 0, 0, $blurW, $blurH)
    $blurG.Dispose()
    $script:blurFull = New-Object System.Drawing.Bitmap($width, $height)
    $upG = [System.Drawing.Graphics]::FromImage($script:blurFull)
    $upG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $upG.DrawImage($blurSmall, 0, 0, $width, $height)
    $upG.Dispose()
    $blurSmall.Dispose()
} catch {
    $script:blurFull = $null
}

# Full-screen selection overlay: frosted backdrop, sharp original inside the
# drag selection.
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.SetBounds($screen.X, $screen.Y, $width, $height)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true
try {
    $dbProp = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Instance)
    $dbProp.SetValue($form, $true, $null)
} catch { }
$script:startPoint = $null
$script:selection = $null
$script:drawing = $false

$form.Add_Paint({
    param($sender, $e)
    $gfx = $e.Graphics
    if ($null -ne $script:blurFull) {
        $gfx.DrawImage($script:blurFull, 0, 0, $width, $height)
    } else {
        $gfx.DrawImage($bmp, 0, 0, $width, $height)
    }
    $sel = $script:selection
    if ($null -ne $sel -and $sel.Width -gt 0 -and $sel.Height -gt 0) {
        # sharp original inside the selection
        $gfx.SetClip($sel)
        $gfx.DrawImage($bmp, 0, 0, $width, $height)
        $gfx.ResetClip()
        # dim outside the selection
        $dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(130, 0, 0, 0))
        $gfx.FillRectangle($dim, 0, 0, $width, $sel.Y)
        $gfx.FillRectangle($dim, 0, ($sel.Y + $sel.Height), $width, ($height - $sel.Y - $sel.Height))
        $gfx.FillRectangle($dim, 0, $sel.Y, $sel.X, $sel.Height)
        $gfx.FillRectangle($dim, ($sel.X + $sel.Width), $sel.Y, ($width - $sel.X - $sel.Width), $sel.Height)
        $dim.Dispose()
        # border
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 120, 215), 2)
        $gfx.DrawRectangle($pen, $sel)
        $pen.Dispose()
        # size label
        $label = ($sel.Width).ToString() + ' x ' + ($sel.Height).ToString()
        $font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
        $size = $gfx.MeasureString($label, $font)
        $bx = $sel.X + 2
        $by = $sel.Y - $size.Height - 4
        if ($by -lt 0) { $by = $sel.Y + 2 }
        $gfx.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))), $bx, $by, $size.Width + 8, $size.Height + 4)
        $gfx.DrawString($label, $font, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $bx + 4, $by + 2)
        $font.Dispose()
    }
})
$form.Add_MouseDown({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and -not $script:drawing) {
        # Re-selection on the already captured image (the image is what the
        # user sees, so a fresh press starts a new box over the same shot).
        $script:startPoint = $e.Location
        $script:selection = New-Object System.Drawing.Rectangle($e.Location, (New-Object System.Drawing.Size(0, 0)))
        $script:drawing = $true
        $form.Invalidate()
    }
})
$form.Add_MouseMove({
    param($sender, $e)
    if ($script:drawing -and $null -ne $script:startPoint) {
        $x = [Math]::Min($script:startPoint.X, $e.X)
        $y = [Math]::Min($script:startPoint.Y, $e.Y)
        $w = [Math]::Abs($script:startPoint.X - $e.X)
        $h = [Math]::Abs($script:startPoint.Y - $e.Y)
        $script:selection = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
        $form.Invalidate()
    }
})
$form.Add_MouseUp({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:drawing) {
        $script:drawing = $false
        $x = [Math]::Min($script:startPoint.X, $e.X)
        $y = [Math]::Min($script:startPoint.Y, $e.Y)
        $w = [Math]::Abs($script:startPoint.X - $e.X)
        $h = [Math]::Abs($script:startPoint.Y - $e.Y)
        $script:selection = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
        if ($w -ge 3 -and $h -ge 3) {
            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
        } else {
            $script:startPoint = $null
            $script:selection = $null
            $form.Invalidate()
        }
    }
})
$form.Add_KeyDown({
    param($sender, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Close()
    }
})
$form.Add_Shown({
    param($sender, $e)
    try { [MLTop]::SetWindowPos($form.Handle, (New-Object IntPtr -ArgumentList (-1)), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null } catch { }
    $form.Activate()
    # If the user already released (fast click before the overlay showed), do
    # not start a drag: wait for a fresh press on the overlay instead.
    if ([MLHooks]::LeftButtonDown()) {
        $script:startPoint = New-Object System.Drawing.Point($cx, $cy)
        $script:selection = New-Object System.Drawing.Rectangle($cx, $cy, 0, 0)
        $script:drawing = $true
    }
    $form.Invalidate()
})

$result = $form.ShowDialog()
[MLHooks]::UninstallKeys()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $null -ne $script:selection -and $script:selection.Width -ge 3 -and $script:selection.Height -ge 3) {
    $crop = $bmp.Clone($script:selection, $bmp.PixelFormat)
    $crop.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $crop.Dispose()
    $g.Dispose()
    $bmp.Dispose()
    if ($null -ne $script:blurFull) { $script:blurFull.Dispose() }
    $form.Dispose()
    exit 0
}
$g.Dispose()
$bmp.Dispose()
if ($null -ne $script:blurFull) { $script:blurFull.Dispose() }
$form.Dispose()
exit 2
exit 2`

// A screenshot capture is inherently single-user: two overlays at once would
// fight over the screen. The flag serializes route calls and tool calls alike.
let captureBusy = false

async function captureScreenshot(mode, signal) {
  if (captureBusy) {
    throw new Error('another screenshot capture is already running')
  }
  captureBusy = true
  let dir
  try {
    const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { homedir, tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-shot-'))
    const scriptPath = join(dir, 'capture.ps1')
    // PNGs land in <home>\Downloads\modlens-screenshots with a readable
    // timestamped name, so the user can find and delete them easily (temp-dir
    // files were effectively invisible garbage). The script itself stays in a
    // private 0600 temp dir and is removed either way.
    const shotsDir = join(homedir(), 'Downloads', 'modlens-screenshots')
    await mkdir(shotsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(shotsDir, `screenshot-${stamp}-${mode}.png`)
    // UTF-8 BOM: powershell.exe 5.1 reads a BOM-less .ps1 as ANSI (GBK on
    // Chinese Windows), which garbles the Chinese hint text below.
    await writeFile(scriptPath, `\uFEFF${CAPTURE_SCRIPT(ui)}`, { mode: 0o600 })
    const { code, stderr } = await runCapture(scriptPath, outPath, mode, signal)
    // The temp dir only ever holds the .ps1; clean it on every exit path.
    await rm(dir, { recursive: true, force: true })
    if (code === 2) {
      // User dismissed (Esc on the banner or the region overlay): no image.
      return { cancelled: true }
    }
    if (code !== 0) {
      throw new Error((stderr || 'unknown capture error').trim().slice(0, 500))
    }
    return { path: outPath }
  } finally {
    captureBusy = false
  }
}

function runCapture(scriptPath, outPath, mode, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-OutPath',
        outPath,
        '-Mode',
        mode,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('screenshot capture timed out'))
    }, CAPTURE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function registerScreenshotRoute(host) {
  host.webServer.register({
    name: 'dsh-screenshot',
    kind: 'exact',
    path: '/dsh-screenshot/screenshot',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      const remote = req.socket?.remoteAddress ?? ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!loopback) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'screenshot route is loopback-only' }))
        return
      }
      const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') === 'region' ? 'region' : 'full'
      try {
        const shot = await captureScreenshot(mode)
        if (shot.cancelled) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ cancelled: true }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: shot.path }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  })
}

const screenshotTool = (toolName) => ({
  name: toolName,
  description:
    "Capture this machine's screen to a PNG and read it through the modlens vision bridge, returning the same structured evidence as modlens_read_image plus the screenshot file path. Use when the user asks what is on their screen, wants a UI inspected, or asks for a screenshot. Mode 'full' captures the whole virtual desktop without interaction; mode 'region' pops an on-screen selection overlay the user must drag (blocks until they choose or press Esc). Requires a configured modlens engine (run `npx @liustack/modlens doctor` to check) and an interactive desktop session.",
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['full', 'region'],
        description:
          "'full' (default) captures the whole virtual desktop; 'region' shows an overlay and asks the user to drag-select an area",
      },
      prompt: {
        type: 'string',
        description: 'Optional extra focus for the reading (e.g. "read the error message")',
      },
    },
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
  },
  timeoutMs: CLI_TIMEOUT_MS + CAPTURE_TIMEOUT_MS + 20_000,
  isConcurrencySafe: () => false,
  presentCall: (args) => ({
    card: 'generic',
    title: toolName,
    kind: 'read',
    rawInput: args,
  }),
  async execute(args, exec) {
    const mode = args?.mode === 'region' ? 'region' : 'full'
    const shot = await captureScreenshot(mode, exec.signal)
    if (shot.cancelled) {
      return {
        summary: 'The screenshot was cancelled: the region selection was dismissed (Esc) with no image captured.',
        ocr: { full_text: '', lines: [] },
        layout: { regions: [] },
        semantics: { scene: '', entities: [] },
        visual: {},
        uncertainty: ['capture cancelled'],
      }
    }
    const cliArgs = [CLI_PATH, '-i', shot.path, '--timeout', String(CLI_TIMEOUT_MS)]
    if (args?.prompt) {
      cliArgs.push('--prompt', args.prompt)
    }
    const { stdout, stderr, code } = await run(process.execPath, cliArgs, exec.signal)
    if (code !== 0) {
      throw new Error(`modlens failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new Error(`modlens produced no JSON: ${stdout.trim().slice(0, 300)}`)
    }
    return { ...parsed.result, screenshotPath: shot.path }
  },
})

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      // In the packaged desktop app process.execPath is the Electron binary;
      // this makes it behave as plain node for the spawned CLI (issue #25).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

function renderEvidence(value) {
  const lines = [value.summary]
  const text = value.ocr?.full_text?.trim()
  if (text) {
    lines.push('', 'Transcription:', text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  }
  const uncertainty = value.uncertainty ?? []
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`)
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  resolveUi(config)
  // Loopback-only capture route for the browser hotkeys.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      if (config.route !== false) {
        try {
          registerScreenshotRoute(scope)
        } catch (error) {
          console.error('[dsh-screenshot] route skipped:', error)
        }
      }
    })
  }
  // Agent-facing tool: capture + read through modlens in one call. Skipped
  // cleanly when no modlens CLI is resolvable - the capture route still works.
  if (CLI_PATH && config.tool !== false) {
    try {
      ctx.tools.register(screenshotTool('modlens_screenshot'))
    } catch (error) {
      console.error('[dsh-screenshot] tool skipped:', error)
    }
  }
}
