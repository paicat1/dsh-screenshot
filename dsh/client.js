// Browser half of the dsh-screenshot plugin.
//
// Adds two hotkeys that ask the host to capture the desktop (PowerShell
// CopyFromScreen, no consent picker) and then drop the image path into the
// composer, the same trigger shape paste-to-path uses. Ctrl+Alt+S = region
// selection, Ctrl+Shift+Alt+S = full screen. (Ctrl+Shift+S is Edge's
// web-capture shortcut, so region lives on Ctrl+Alt+S.) The host route is
// loopback-only.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages - the same zero-dependency stance as the
// host half.
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    // The composer textarea (the input bar's real element). Prefer the
    // data-composer-card scope (current ui-conversation bundle), fall back to
    // any textarea carrying data-phase (the input bar's own marker).
    function composerTextarea() {
      var el = document.querySelector('[data-composer-card] textarea')
      if (el) return el
      el = document.querySelector('textarea[data-phase]')
      return el || null
    }

    // Two short label sets, mirroring the modlens client convention: prefer
    // the document lang (dsh sets it from the profile), fall back to the
    // browser language, then en. No locale framework - just the strings the
    // toast can actually show.
    var TEXT = {
      en: {
        regionInserted: 'Region screenshot path inserted',
        fullInserted: 'Full-screen screenshot path inserted',
        hostRouteNotLoaded: 'Screenshot unavailable: restart the dsh service and refresh (host route not loaded)',
        failed: 'Screenshot failed: ',
      },
      zh: {
        regionInserted: '区域截图已插入输入框',
        fullInserted: '全屏截图已插入输入框',
        hostRouteNotLoaded: '截图功能未生效：请重启 dsh 服务后刷新页面（host 端路由未加载）',
        failed: '截图失败：',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    // Minimal transient toast for capture feedback; styled inline so the
    // plugin stays dependency-free (no CSS module, no React).
    function toast(message, isError) {
      var div = document.createElement('div')
      div.textContent = message
      div.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'padding:8px 14px;border-radius:8px;font:12px/1.5 system-ui,sans-serif;color:#fff;' +
        'background:' +
        (isError ? 'rgba(200,50,50,.95)' : 'rgba(20,20,20,.92)') +
        ';box-shadow:0 2px 12px rgba(0,0,0,.35);pointer-events:none;'
      document.body.appendChild(div)
      setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div)
      }, 3500)
    }

    function triggerScreenshot(mode) {
      fetch(`/dsh-screenshot/screenshot?mode=${encodeURIComponent(mode)}`)
        .then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `screenshot failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        })
        .then((body) => {
          if (!body || body.cancelled) return
          if (body.path) {
            var target = composerTextarea() || document.activeElement
            insertText(target, `${body.path} `)
            var t = labels()
            toast(mode === 'region' ? t.regionInserted : t.fullInserted)
          }
        })
        .catch((error) => {
          console.error('[dsh-screenshot] screenshot failed:', error?.message ?? error)
          var t = labels()
          if (error && error.status === 404) {
            toast(t.hostRouteNotLoaded, true)
          } else {
            toast(t.failed + (error?.message ?? error), true)
          }
        })
    }

    function onScreenshotKeyDown(event) {
      var key = (event.key || '').toLowerCase()
      if (key !== 's') return
      var ctrl = event.ctrlKey || event.metaKey
      // Ctrl+Alt+S = region, Ctrl+Shift+Alt+S = full (Ctrl+Shift+S is the
      // browser's own web-capture shortcut in Edge, so region moved off it)
      if (!ctrl || !event.altKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      triggerScreenshot(event.shiftKey ? 'full' : 'region')
    }

    function apply(ctx) {
      document.addEventListener('keydown', onScreenshotKeyDown, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('keydown', onScreenshotKeyDown, true)
          },
          'dsh-screenshot: hotkey listener',
        )
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
