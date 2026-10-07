// Stylesheet injection for the client half. The CSS is a static asset, not
// logic — keeping it here is what lets `index.tsx` read as components.

const STYLE_TAG = 'dsh-file-upload/style.css'

/** Inject the plugin stylesheet once; returns a disposer removing it on stop/update. */
export function injectCss(): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-file-upload'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = `
.dsh-upload-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;border-radius:6px;padding:4px;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.dsh-upload-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,currentColor)}
.dsh-upload-btn:disabled{opacity:.45;cursor:default}
.dsh-upload-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset);display:flex;flex-wrap:wrap;gap:8px;flex:none}
.dsh-upload-card{position:relative;flex-direction:column;align-items:center;gap:5px;width:88px;flex:none;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-specific-input-major,var(--dsw-alias-surface-2,rgba(127,127,127,.08)));border-radius:12px;padding:12px 8px 9px;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}
.dsh-upload-badge{width:44px;height:56px;border-radius:6px;color:#fff;font-size:12px;font-weight:700;font-family:var(--ds-font-family-code,monospace);display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;flex:none;box-shadow:inset 0 -10px 14px rgba(0,0,0,.14),inset 0 10px 12px rgba(255,255,255,.16)}
.dsh-upload-name{width:100%;font-size:12px;line-height:16px;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.dsh-upload-size{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px;flex:none}
.dsh-upload-progress{width:100%;height:3px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.dsh-upload-progress-fill{height:100%;border-radius:2px;background:var(--dsw-alias-border-accent,rgba(99,132,255,.55));transition:width .12s ease}
.dsh-upload-card-error .dsh-upload-size{color:var(--dsw-alias-state-error-primary,#d86161)}
.dsh-upload-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-upload-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-upload-card>.dsh-upload-remove{position:absolute;top:4px;right:4px}
.dsh-upload-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-upload-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.dsh-upload-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-surface-1,#101014) 72%,transparent);backdrop-filter:blur(2px);opacity:0;transition:opacity .12s ease}
.dsh-upload-overlay.active{opacity:1}
.dsh-upload-overlay-box{border:2px dashed var(--dsw-alias-border-accent,rgba(99,132,255,.55));border-radius:16px;padding:28px 44px;color:var(--dsw-alias-label-primary,inherit);font-size:15px;display:flex;flex-direction:column;align-items:center;gap:8px;background:var(--dsw-specific-input-major,rgba(127,127,127,.08))}
.dsh-upload-overlay-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
`
  document.head.appendChild(tag)
  return () => tag.remove()
}