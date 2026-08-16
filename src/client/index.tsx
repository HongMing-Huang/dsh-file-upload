// dsh-file-upload client face: Claude-desktop-style file upload.
//   - paperclip button in the composer toolbar (conversation.input.left)
//   - global drag-and-drop overlay: drag files anywhere over the window and
//     drop them onto the chat to attach (conversation.input.dock hosts cards)
//   - small text files are inlined straight into the composer via the
//     official `slash/input-insert-text` event; larger text and documents
//     insert a path reference the agent reads with read_document.
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-uploads/<sessionId>), where the agent's fs backend can
// always resolve them.

import { useEffect, useRef, useState } from 'react'
import { Tooltip, IconPaperclipOutline16, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

const SOURCE_NAME = 'dsh-file-upload'
const STYLE_TAG = 'dsh-file-upload/style.css'
/** Mirrors the host `maxRecordSec` default; the host config wins for uploads. */
const MAX_RECORD_SEC = 60

interface UploadMeta {
  name: string
  bytes: number
  label: string
  status: 'uploading' | 'ready' | 'error'
  error?: string
  previewUrl?: string
  relativePath?: string
}

/** Per-session attachment metadata: Map<sessionId, Map<path, meta>>. */
const uploadMetaBySession = new Map<string, Map<string, UploadMeta>>()

function metaFor(sessionId: string): Map<string, UploadMeta> {
  let m = uploadMetaBySession.get(sessionId)
  if (m === undefined) {
    m = new Map()
    uploadMetaBySession.set(sessionId, m)
  }
  return m
}
let uploadError: { seq: number; text: string } | null = null
let errorSeq = 0
const errorListeners = new Set<() => void>()

function subscribeErrors(listener: () => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function setUploadError(text: string): void {
  uploadError = { seq: ++errorSeq, text }
  for (const listener of errorListeners) listener()
}

function clearUploadError(): void {
  uploadError = null
  for (const listener of errorListeners) listener()
}

function badgeStyle(name: string): { bg: string; ext: string } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4)
  const lower = ext.toLowerCase()
  if (lower === 'pdf') return { bg: '#C93B2E', ext: 'PDF' }
  if (lower === 'docx' || lower === 'doc') return { bg: '#2B579A', ext: 'DOC' }
  if (lower === 'xlsx' || lower === 'xls') return { bg: '#217346', ext: 'XLS' }
  if (lower === 'csv' || lower === 'tsv') return { bg: '#217346', ext: 'CSV' }
  if (lower === 'txt' || lower === 'md' || lower === 'markdown') return { bg: '#757575', ext: 'TXT' }
  if (lower === 'zip') return { bg: '#7A5BB0', ext: 'ZIP' }
  if (lower === 'json' || lower === 'jsonl') return { bg: '#B8860B', ext: 'JSON' }
  if (lower === 'png' || lower === 'jpg' || lower === 'jpeg' || lower === 'gif' || lower === 'webp') return { bg: '#2E7D6B', ext: 'IMG' }
  return { bg: '#5B7DB1', ext: ext === '' ? 'FILE' : ext }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return
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
.dsh-upload-remove{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;line-height:0;flex:none}
.dsh-upload-remove:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-upload-card>.dsh-upload-remove{position:absolute;top:4px;right:4px}
.dsh-upload-error{display:inline-flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.22));background:var(--dsw-alias-interactive-bg-hover-danger,rgba(216,97,97,.14));color:var(--dsw-alias-state-error-primary,#d86161);border-radius:10px;padding:6px 8px 6px 10px;font-size:13px}
.dsh-upload-error-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.dsh-upload-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-surface-1,#101014) 72%,transparent);backdrop-filter:blur(2px);opacity:0;transition:opacity .12s ease}
.dsh-upload-overlay.active{opacity:1}
.dsh-upload-overlay-box{border:2px dashed var(--dsw-alias-border-accent,rgba(99,132,255,.55));border-radius:16px;padding:28px 44px;color:var(--dsw-alias-label-primary,inherit);font-size:15px;display:flex;flex-direction:column;align-items:center;gap:8px;background:var(--dsw-specific-input-major,rgba(127,127,127,.08))}
.dsh-upload-overlay-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.dsh-mic-btn.recording{color:#e5484d;animation:dsh-mic-pulse 1s ease-in-out infinite}
@keyframes dsh-mic-pulse{0%,100%{opacity:1}50%{opacity:.35}}
`
  document.head.appendChild(tag)
}

interface InputSnapshot {
  draft: string
  draftRev: number
  occurrences: Array<{ source: string; ref: string; occurrenceId: string; offset: number }>
}

interface InputService {
  for(actx: unknown): {
    state: { getSnapshot(): InputSnapshot }
  }
}

interface ConversationService {
  input: InputService
}

interface ActionContext {
  get(name: string): ConversationService | undefined
  emit(event: string, payload: Record<string, unknown>): void
}

interface UploadResponse {
  path?: string
  name?: string
  bytes?: number
  sniffedType?: string
  label?: string
  inlineText?: string
  preview?: string
  imageMode?: 'native' | 'ocr'
  relativePath?: string
  error?: string
}

function httpErrorText(status: number): string {
  if (status === 413) return '文件超过大小限制'
  if (status === 415) return '文件类型不被允许'
  if (status === 403) return '会话校验失败，请刷新页面重试'
  if (status === 429) return '上传太频繁，请稍后再试'
  return `HTTP ${status}`
}

async function uploadFile(actx: ActionContext, file: File, sessionId: string): Promise<string | null> {
  const conversation = actx.get('conversation')
  if (conversation === undefined) throw new Error('conversation service unavailable')
  const input = conversation.input.for(actx)

  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(file.name),
      'x-session-id': sessionId
    },
    body: file
  })
  if (!res.ok) {
    let detail = httpErrorText(res.status)
    try {
      const payload = (await res.json()) as { error?: string }
      if (typeof payload.error === 'string') detail = payload.error
    } catch {
      // keep the status-based message
    }
    throw new Error(`${file.name}: ${detail}`)
  }
  const payload = (await res.json()) as UploadResponse
  if (typeof payload.path !== 'string') throw new Error('missing path in response')
  const name = payload.name ?? file.name
  const bytes = payload.bytes ?? file.size
  metaFor(sessionId).set(payload.path, {
    name,
    bytes,
    label: payload.label ?? name.slice(name.lastIndexOf('.') + 1).toUpperCase(),
    status: 'ready',
    ...(payload.relativePath !== undefined ? { relativePath: payload.relativePath } : {}),
    ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {})
  })
  clearUploadError()

  const state = input.state.getSnapshot()

  if (typeof payload.inlineText === 'string') {
    // Claude-desktop-style: the file content lands in the composer directly.
    const text = `[file: ${name}]\n${payload.inlineText}`
    actx.emit('slash/input-insert-text', {
      text,
      span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev }
    })
    return payload.path
  }

  if (payload.sniffedType === 'image' && payload.imageMode === 'native') {
    // Multimodal route: the agent reads the image directly with read_image.
    const text = `[图片: ${name}] 当前模型支持图像输入,请用 read_image 工具查看 ${payload.path}`
    actx.emit('slash/input-insert-text', {
      text,
      span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev }
    })
    return payload.path
  }

  // Larger text or documents: insert a path reference (Codex-style
  // `@relative/path`); the agent reads it with read_document (converted to
  // Markdown on demand).
  const refText = payload.relativePath !== undefined ? `@${payload.relativePath}` : payload.path
  const label = payload.preview !== undefined ? `[file: ${name}] (preview) ${payload.preview}` : ''
  actx.emit('slash/input-insert-reference', {
    reference: {
      source: SOURCE_NAME,
      ref: payload.path,
      label,
      clipboardText: refText
    },
    span: {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev
    }
  })
  return payload.path
}

async function attachFiles(actx: ActionContext, files: File[], sessionId: string): Promise<void> {
  for (const file of files) {
    try {
      await uploadFile(actx, file, sessionId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }
}

interface UploadButtonProps {
  attach: (files: File[]) => Promise<void>
}

function UploadButton({ attach }: UploadButtonProps) {
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    inputRef.current = input
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.remove()
      inputRef.current = null
      if (files.length === 0) return
      setBusy(true)
      void attach(files).finally(() => setBusy(false))
    }
    input.click()
  }
  return (
    <Tooltip label={busy ? '上传中…' : '上传文件'} side="top">
      <button type="button" className="dsh-upload-btn" aria-label="上传文件" disabled={busy} onClick={pick}>
        <IconPaperclipOutline16 size={14} />
      </button>
    </Tooltip>
  )
}

/** Voice input button: Web Speech API live dictation into the composer.
 * Falls back to MediaRecorder + file upload when speech recognition is
 * unavailable (the host transcribes audio files when ASR is configured). */
function MicButton({
  attach,
  insert,
  maxSec
}: {
  attach: (files: File[]) => Promise<void>
  insert: (text: string) => void
  maxSec: number
}) {
  const [recording, setRecording] = useState(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = () => {
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  const toggle = () => {
    if (recording) {
      stop()
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (SR !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec = new SR() as any
      rec.lang = navigator.language || 'zh-CN'
      rec.continuous = true
      rec.interimResults = true
      let draft = ''
      const actx = null as unknown
      rec.onresult = (event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
        let text = ''
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const item = event.results[i]
          if (item.length > 0) text += item[0].transcript
        }
        draft = text
      }
      rec.onend = () => {
        setRecording(false)
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        if (draft.trim() !== '') insert(draft.trim())
      }
      rec.onerror = () => {
        setRecording(false)
        setUploadError('语音识别不可用,已切换为录音文件上传')
        // Fall back to recording an audio file.
        void recordAndAttach(attach, maxSec)
      }
      recRef.current = { stop: () => rec.stop() }
      setRecording(true)
      rec.start()
      timeoutRef.current = setTimeout(stop, maxSec * 1000)
      return
    }
    // No Web Speech API: record an audio file and upload it.
    void recordAndAttach(attach, maxSec)
  }

  return (
    <Tooltip label={recording ? '停止录音' : '语音输入'} side="top">
      <button
        type="button"
        className={`dsh-upload-btn dsh-mic-btn${recording ? ' recording' : ''}`}
        aria-label="语音输入"
        onClick={toggle}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4A2.5 2.5 0 0 0 8 1.5Z"
            fill="currentColor"
          />
          <path
            d="M3.5 7.5a.75.75 0 0 1 1.5 0 2.5 2.5 0 0 0 5 0 .75.75 0 0 1 1.5 0 4 4 0 0 1-3.25 3.94V13H10a.75.75 0 0 1 0 1.5H6A.75.75 0 0 1 6 13h1.75v-1.56A4 4 0 0 1 4.5 8a.75.75 0 0 1 .5-.75.75.75 0 0 1 .5-.5Z"
            fill="currentColor"
            transform="translate(0 -1)"
          />
        </svg>
      </button>
    </Tooltip>
  )
}

/** MediaRecorder fallback: record an audio file and upload it. */
async function recordAndAttach(attach: (files: File[]) => Promise<void>, maxSec: number): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mime = (window as any).MediaRecorder.isTypeSupported?.('audio/webm') ? 'audio/webm' : ''
    const recorder = new MediaRecorder(stream, mime !== '' ? { mimeType: mime } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: mime || 'audio/webm' })
      const ext = mime.includes('mp4') ? 'm4a' : 'webm'
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type })
      void attach([file])
    }
    recorder.start()
    setTimeout(() => recorder.stop(), maxSec * 1000)
  } catch (err) {
    setUploadError(`无法访问麦克风: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Global drag overlay: drag files over the window to attach (Claude style). */
function DragOverlay({ attach }: { attach: (files: File[]) => Promise<void> }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current += 1
      setActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) void attach(files)
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [attach])

  return (
    <div ref={overlayRef} className={`dsh-upload-overlay${active ? ' active' : ''}`}>
      <div className="dsh-upload-overlay-box">
        <div>松开以添加文件</div>
        <div className="dsh-upload-overlay-hint">文件将上传到当前会话，agent 可读取其内容</div>
      </div>
    </div>
  )
}

interface DockProps {
  attach: (files: File[]) => Promise<void>
  sessionId: string
}

function UploadDock({ attach, sessionId }: DockProps) {
  const [metaVersion, setMetaVersion] = useState(0)
  const [error, setError] = useState<{ seq: number; text: string } | null>(null)

  useEffect(() => {
    const offs = [
      subscribeErrors((next) => {
        setError(next)
        setMetaVersion((v) => v + 1)
      })
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])

  const removeCard = (ref: string): void => {
    metaFor(sessionId).delete(ref)
    setMetaVersion((v) => v + 1)
    void fetch('/api/upload', {
      method: 'DELETE',
      headers: {
        'x-session-id': sessionId,
        'x-file-path': ref
      }
    }).catch(() => undefined)
  }

  const entries = Array.from(metaFor(sessionId).entries())

  return (
    <>
      {entries.length > 0 && (
        <div className="dsh-upload-dock">
          {entries.map(([ref, meta]) => {
            const badge = badgeStyle(meta.name)
            return (
              <div key={ref} className="dsh-upload-card">
                {meta.previewUrl !== undefined ? (
                  <img
                    src={meta.previewUrl}
                    alt={meta.name}
                    className="dsh-upload-thumb"
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }}
                  />
                ) : (
                  <div className="dsh-upload-badge" style={{ background: badge.bg }}>
                    {badge.ext}
                  </div>
                )}
                <div className="dsh-upload-name" title={meta.name}>
                  {meta.name}
                </div>
                <div className="dsh-upload-size">{formatBytes(meta.bytes)}</div>
                <Tooltip label="移除" side="top">
                  <button
                    type="button"
                    className="dsh-upload-remove"
                    aria-label="移除"
                    onClick={() => removeCard(ref)}
                  >
                    <IconCloseOutline16 size={12} />
                  </button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
      {error !== null && (
        <div className="dsh-upload-error">
          <span className="dsh-upload-error-text">{error.text}</span>
          <button
            type="button"
            className="dsh-upload-remove"
            aria-label="关闭"
            onClick={() => setError(null)}
          >
            <IconCloseOutline16 size={12} />
          </button>
        </div>
      )}
      <DragOverlay attach={attach} />
    </>
  )
}

export function apply(ctx: {
  effect(fn: () => unknown): void
  inputTriggers: {
    registerSource(source: Record<string, unknown>): void
  }
  slots: {
    inject(name: string, fn: () => unknown): void
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  sessions: {
    scope(sessionId: string): ActionContext
  }
}): void {
  injectCss()
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: '@',
      name: SOURCE_NAME,
      // Codex-style: pick an already-uploaded file by its relative path.
      candidates: async (projection: { sessionId: string }) => {
        const metas = uploadMetaBySession.get(projection.sessionId)
        if (metas === undefined) return []
        return Array.from(metas.entries()).map(([path, meta]) => ({
          name: meta.relativePath ?? path,
          description: `${meta.label} · ${formatBytes(meta.bytes)}`,
          icon: '📎'
        }))
      },
      onPick: (pick: {
        candidate: { name: string }
        session: { sessionId: string }
      }): { insert: { source: string; ref: string; label: string; clipboardText: string } } | undefined => {
        const metas = uploadMetaBySession.get(pick.session.sessionId)
        if (metas === undefined) return undefined
        for (const [path, meta] of metas.entries()) {
          if ((meta.relativePath ?? path) === pick.candidate.name) {
            return {
              insert: {
                source: SOURCE_NAME,
                ref: path,
                label: meta.name,
                clipboardText: `@${meta.relativePath ?? path}`
              }
            }
          }
        }
        return undefined
      },
      codec: {
        clipboardText: (ref: string) => ref,
        serialize: async (ref: string) => ref
      }
    })
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-file-upload-button',
        order: 0,
        inject: (sessionId: string) => ({
          attach: (files: File[]) => attachFiles(ctx.sessions.scope(sessionId), files, sessionId)
        })
      },
      UploadButton
    )
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-file-upload-mic',
        order: 1,
        inject: (sessionId: string) => {
          const actx = ctx.sessions.scope(sessionId)
          return {
            attach: (files: File[]) => attachFiles(actx, files, sessionId),
            insert: (text: string) => {
              const conversation = actx.get('conversation')
              const input = conversation?.input.for(actx)
              const state = input?.state.getSnapshot()
              actx.emit('slash/input-insert-text', {
                text,
                span: { start: state?.draft.length ?? 0, end: state?.draft.length ?? 0, draftRev: state?.draftRev ?? 0 }
              })
            },
            maxSec: MAX_RECORD_SEC
          }
        }
      },
      MicButton
    )
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-file-upload-dock',
        order: 5,
        inject: (sessionId: string) => ({
          attach: (files: File[]) => attachFiles(ctx.sessions.scope(sessionId), files, sessionId)
        })
      },
      UploadDock
    )
  )
}

// The client bundle must export the plugin object; esbuild iife does not write
// module.exports automatically, so assign it explicitly (banner defines the
// module variable at runtime). Mirrors the official dual-face plugin pattern.
declare const module: { exports: unknown } | undefined
if (typeof module !== 'undefined' && module !== null) {
  module.exports = {
    apply,
    inject: ['slots', 'inputTriggers', 'sessions']
  }
}
