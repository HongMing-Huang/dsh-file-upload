// dsh-file-upload client face: Claude-desktop-style file upload.
//   - paperclip button in the composer toolbar (conversation.input.left)
//   - global drag-and-drop overlay: drag files anywhere over the window and
//     drop them onto the chat to attach (conversation.input.dock hosts cards)
//   - small text files are inlined straight into the composer via the
//     official `slash/input-insert-text` event; larger text and documents
//     insert a path reference the agent reads with read_document.
//   - uploads stream through XMLHttpRequest so each card can show live
//     progress, and an in-flight card can be cancelled (the XHR is aborted).
// Uploads carry the session id so the host stores files inside that session's
// workspace (.dsh-uploads/<sessionId>), where the agent's fs backend can
// always resolve them.

import { useEffect, useRef, useState } from 'react'
// The primitives export size-graded glyph families (`…Regular` / `…Medium`),
// not the `…16` names this file used originally; those do not exist in the
// shipped runtime, so both icons resolved to `undefined` and the paperclip and
// the two remove buttons rendered nothing. `Regular` is the 16-18px grade the
// official client plugins use in toolbars.
import { Tooltip, IconPaperclipOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, zh, en, type Translator } from './locale.ts'
import { injectCss } from './style.ts'

const SOURCE_NAME = 'dsh-file-upload'

interface UploadMeta {
  name: string
  bytes: number
  label: string
  status: 'uploading' | 'ready' | 'error'
  error?: string
  /** Upload fraction 0..1 while `status` is 'uploading'; only set when the total is known. */
  progress?: number
  /** Aborts the in-flight request; present only while `status` is 'uploading'. */
  abort?: () => void
  previewUrl?: string
  /** Absolute host path — used for DELETE only, never shown to the model. */
  absolutePath?: string
  relativePath?: string
}

/** Per-session attachment metadata: Map<sessionId, Map<path, meta>>. */
const uploadMetaBySession = new Map<string, Map<string, UploadMeta>>()

/** Card ids for uploads that have not reported their final path yet. */
let uploadSeq = 0

function metaFor(sessionId: string): Map<string, UploadMeta> {
  let m = uploadMetaBySession.get(sessionId)
  if (m === undefined) {
    m = new Map()
    uploadMetaBySession.set(sessionId, m)
  }
  return m
}

const metaListeners = new Set<() => void>()

function subscribeMeta(listener: () => void): () => void {
  metaListeners.add(listener)
  return () => {
    metaListeners.delete(listener)
  }
}

/** Re-render every mounted dock after a card appeared, progressed or vanished. */
function notifyMeta(): void {
  for (const listener of metaListeners) listener()
}

interface UploadError {
  seq: number
  text: string
}

let uploadError: UploadError | null = null
let errorSeq = 0
const errorListeners = new Set<(err: UploadError | null) => void>()

function subscribeErrors(listener: (err: UploadError | null) => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function setUploadError(text: string): void {
  uploadError = { seq: ++errorSeq, text }
  for (const listener of errorListeners) listener(uploadError)
}

function clearUploadError(): void {
  uploadError = null
  for (const listener of errorListeners) listener(uploadError)
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

/** Card subtitle: live percentage while uploading, size once stored, failure text. */
function cardCaption(meta: UploadMeta, t: Translator): string {
  if (meta.status === 'uploading') return meta.progress === undefined ? t('upload.busy') : `${Math.round(meta.progress * 100)}%`
  if (meta.status === 'error') return t('upload.failed')
  return formatBytes(meta.bytes)
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
  imageMode?: 'native' | 'ocr'
  imageDescription?: string
  relativePath?: string
  error?: string
}

function httpErrorText(status: number, t: Translator): string {
  if (status === 413) return t('http.413')
  if (status === 415) return t('http.415')
  if (status === 403) return t('http.403')
  if (status === 429) return t('http.429')
  return `HTTP ${status}`
}

/** Thrown when the user cancels an upload: a cancel is not a failure. */
class UploadCancelled extends Error {
  constructor() {
    super('upload cancelled')
    this.name = 'UploadCancelled'
  }
}

/**
 * POST one file through XMLHttpRequest. `fetch` cannot report upload progress
 * in the browser, `xhr.upload.onprogress` can. Headers, body, response parsing
 * and error messages are identical to the previous fetch-based transport.
 */
function postUpload(
  file: File,
  sessionId: string,
  relPath: string | undefined,
  controller: AbortController,
  t: Translator,
  onProgress: (loaded: number, total: number) => void
): Promise<UploadResponse & { path: string }> {
  return new Promise<UploadResponse & { path: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = (): void => xhr.abort()
    controller.signal.addEventListener('abort', onAbort)
    const settle = (): void => controller.signal.removeEventListener('abort', onAbort)

    xhr.open('POST', '/api/upload')
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
    if (relPath !== undefined) xhr.setRequestHeader('x-file-relpath', encodeURIComponent(relPath))
    xhr.setRequestHeader('x-session-id', sessionId)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded, event.total)
    }
    xhr.onabort = () => {
      settle()
      reject(new UploadCancelled())
    }
    xhr.onerror = () => {
      settle()
      reject(new Error(t('upload.networkError', { name: file.name })))
    }
    xhr.onload = () => {
      settle()
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = httpErrorText(xhr.status, t)
        try {
          const payload = JSON.parse(xhr.responseText) as {
            error?: string
            code?: string
            params?: Record<string, string>
          }
          // Server failures carry a machine-readable code so the message can
          // follow the locale. The prose stays as the fallback for a code this
          // build does not know (a newer server) and for code-less bodies.
          const key = typeof payload.code === 'string' ? `error.${payload.code}` : ''
          if (key !== '' && key in zh) detail = t(key, payload.params)
          else if (typeof payload.error === 'string') detail = payload.error
        } catch {
          // keep the status-based message
        }
        reject(new Error(`${file.name}: ${detail}`))
        return
      }
      let payload: UploadResponse
      try {
        payload = JSON.parse(xhr.responseText) as UploadResponse
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      if (typeof payload.path !== 'string') {
        reject(new Error('missing path in response'))
        return
      }
      resolve({ ...payload, path: payload.path })
    }
    if (controller.signal.aborted) onAbort()
    else xhr.send(file)
  })
}

async function uploadFile(actx: ActionContext, file: File, sessionId: string, t: Translator): Promise<string | null> {
  const conversation = actx.get('conversation')
  if (conversation === undefined) throw new Error('conversation service unavailable')
  const input = conversation.input.for(actx)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relPath = (file as any).relPath as string | undefined
  // The card goes up before the request so the user sees it immediately. It is
  // keyed by a provisional id until the server reports the final relative path;
  // `@` candidates only expose `ready` cards, and only a 2xx response inserts a
  // reference into the composer.
  const cardKey = `__upload__:${++uploadSeq}`
  const cards = metaFor(sessionId)
  const controller = new AbortController()
  const card: UploadMeta = {
    name: file.name,
    bytes: file.size,
    label: file.name.slice(file.name.lastIndexOf('.') + 1).toUpperCase(),
    status: 'uploading',
    progress: 0,
    abort: () => controller.abort()
  }
  cards.set(cardKey, card)
  notifyMeta()

  let payload: UploadResponse & { path: string }
  try {
    payload = await postUpload(file, sessionId, relPath, controller, t, (loaded, total) => {
      card.progress = Math.min(1, loaded / total)
      notifyMeta()
    })
  } catch (err) {
    if (err instanceof UploadCancelled) {
      // The user cancelled: drop the card silently, no error banner.
      cards.delete(cardKey)
    } else {
      card.status = 'error'
      card.error = err instanceof Error ? err.message : String(err)
      card.progress = undefined
      card.abort = undefined
    }
    notifyMeta()
    throw err
  }

  const name = payload.name ?? file.name
  // Codex-style reference: the relative path (relative to the session
  // workspace) is what the model sees — never the absolute host path.
  const ref = payload.relativePath !== undefined && payload.relativePath !== '' ? payload.relativePath : payload.path
  card.status = 'ready'
  card.progress = undefined
  card.abort = undefined
  card.name = name
  card.bytes = payload.bytes ?? file.size
  card.label = payload.label ?? name.slice(name.lastIndexOf('.') + 1).toUpperCase()
  card.absolutePath = payload.path
  if (payload.relativePath !== undefined) card.relativePath = payload.relativePath
  if (file.type.startsWith('image/')) card.previewUrl = URL.createObjectURL(file)
  // Re-key the card: the reference is what the dock and the `@` picker use.
  cards.delete(cardKey)
  cards.set(ref, card)
  notifyMeta()
  clearUploadError()

  // Images on text-only routes: when a vision description was generated,
  // insert it as a short text block (that IS the image content entering the
  // message) followed by the Codex-style reference. Everything else — native
  // image routes, plain files, documents — inserts a clean `@relative/path`
  // reference only; no absolute paths, no guidance text, no raw content.
  if (payload.sniffedType === 'image' && payload.imageDescription !== undefined) {
    const text = t('image.description', { name, description: payload.imageDescription })
    const before = input.state.getSnapshot()
    actx.emit('slash/input-insert-text', {
      text,
      span: { start: before.draft.length, end: before.draft.length, draftRev: before.draftRev }
    })
  }

  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-reference', {
    reference: {
      source: SOURCE_NAME,
      ref,
      label: name,
      clipboardText: `@${ref}`
    },
    span: {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev
    }
  })
  return ref
}

/** Recursively collect files from dropped dataTransfer items (folder support). */
async function collectDroppedFiles(items: DataTransferItemList | null): Promise<File[]> {
  if (items === null) return []
  const files: File[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry === null) return
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => entry.file(resolve))
      if (file !== null) {
        if (prefix !== '') {
          const rel = `${prefix}/${file.name}`
          Object.defineProperty(file, 'relPath', { value: rel })
        }
        files.push(file)
      }
      return
    }
    if (entry.isDirectory) {
      const reader = entry.createReader()
      // readEntries returns in batches; loop until empty.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const entries = await new Promise<any[]>((resolve) => reader.readEntries(resolve))
        if (entries.length === 0) break
        for (const child of entries) await walk(child, prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      }
    }
  }
  const jobs: Promise<void>[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
    if (entry !== null) {
      jobs.push(walk(entry, ''))
    } else {
      const f = item.getAsFile()
      if (f !== null) files.push(f)
    }
  }
  await Promise.all(jobs)
  return files
}

/** Files carried by a paste event (images and files). */
function filesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  const files: File[] = []
  if (items !== undefined) {
    for (let i = 0; i < items.length; i += 1) {
      const f = items[i].getAsFile()
      if (f !== null) files.push(f)
    }
  }
  return files
}

async function attachFiles(actx: ActionContext, files: File[], sessionId: string, t: Translator): Promise<void> {
  for (const file of files) {
    try {
      await uploadFile(actx, file, sessionId, t)
    } catch (err) {
      // A user cancel is not a failure: the card is already gone and there is
      // nothing to report.
      if (err instanceof UploadCancelled) continue
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }
}

interface UploadButtonProps {
  attach: (files: File[]) => Promise<void>
  t: Translator
}

function UploadButton({ attach, t }: UploadButtonProps) {
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
    <Tooltip label={busy ? t('upload.busy') : t('upload.label')}>
      <button type="button" className="dsh-upload-btn" aria-label={t('upload.label')} disabled={busy} onClick={pick}>
        <IconPaperclipOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

/** Global drag overlay + paste: drag files/folders anywhere over the window
 * or paste images/files into the composer to attach (Claude/Codex style). */
function DragOverlay({ attach, t }: { attach: (files: File[]) => Promise<void>; t: Translator }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    // The official `dsh-client-ui-conversation` package also listens for
    // `dragenter`/`dragover`/`drop` on the document — in the BUBBLE phase — and
    // shows its own "drop images here" overlay for anything whose
    // `dataTransfer.types` contains `Files`, then rejects non-image drops with
    // "only PNG/JPG/WebP/GIF are supported". The plugin's client half loads after
    // the shell, so its listeners were registered later and therefore ran later:
    // any non-image drop (.md, .pdf, .docx) was consumed by the official overlay
    // and never reached this plugin at all.
    //
    // Registering in the CAPTURE phase (third argument `true`) puts these
    // handlers ahead of the official ones, and `stopImmediatePropagation` on a
    // non-image drop keeps the official overlay from also acting on it. Image-
    // only drags are still handed through untouched, so the official attachment
    // flow is unaffected.
    const dragIsImageOnly = (e: DragEvent): boolean => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((it) => it.kind === 'file')
      if (items.length === 0) return false
      return items.every((it) => /^image\/(png|jpe?g|webp|gif)$/i.test(it.type))
    }
    /** True when this plugin is taking the event and the official one must not. */
    const claimsDrag = (e: DragEvent): boolean => hasFiles(e) && !dragIsImageOnly(e)

    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (claimsDrag(e)) e.stopImmediatePropagation()
      depth.current += 1
      setActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (claimsDrag(e)) e.stopImmediatePropagation()
      e.preventDefault()
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      // Not stopped: `dragleave` is not one of the gestures the official overlay
      // acts on, and swallowing it could leave its state stuck.
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (claimsDrag(e)) e.stopImmediatePropagation()
      e.preventDefault()
      depth.current = 0
      setActive(false)
      void (async () => {
        // Folder support: walk dropped entries (files + directories).
        const files = await collectDroppedFiles(e.dataTransfer?.items ?? null)
        if (files.length > 0) await attach(files)
      })()
    }

    // Paste support: images/files pasted into the composer upload too.
    const onPaste = (e: ClipboardEvent): void => {
      const files = filesFromClipboard(e)
      if (files.length > 0 && files.some((f) => f.type.startsWith('image/') || f.type !== '')) {
        e.preventDefault()
        void attach(files)
      }
    }

    // Capture phase: see the note on `dragIsImageOnly` above — these must run
    // before the official conversation handlers, which sit in the bubble phase.
    document.addEventListener('dragenter', onDragEnter, true)
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('dragenter', onDragEnter, true)
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('paste', onPaste)
    }
  }, [attach])

  return (
    <div className={`dsh-upload-overlay${active ? ' active' : ''}`}>
      <div className="dsh-upload-overlay-box">
        <div>{t('drag.title')}</div>
        <div className="dsh-upload-overlay-hint">{t('drag.desc')}</div>
      </div>
    </div>
  )
}

interface DockProps {
  attach: (files: File[]) => Promise<void>
  sessionId: string
  t: Translator
}

function UploadDock({ attach, sessionId, t }: DockProps) {
  // Only the setter is read: bumping it is what re-renders the dock after a
  // mutation to the module-level meta map. A bare `useState` call keeps the
  // subscription in the same place it has always been.
  const [, setMetaVersion] = useState(0)
  const [error, setError] = useState<UploadError | null>(null)

  useEffect(() => {
    const offs = [
      subscribeErrors((next) => {
        setError(next)
        setMetaVersion((v) => v + 1)
      }),
      subscribeMeta(() => setMetaVersion((v) => v + 1))
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])

  useEffect(() => {
    const cards = metaFor(sessionId)
    return () => {
      // Leaving the session must not leave requests (or cards) hanging.
      for (const [key, meta] of Array.from(cards.entries())) {
        if (meta.status !== 'uploading') continue
        meta.abort?.()
        cards.delete(key)
      }
    }
  }, [sessionId])

  const removeCard = (ref: string): void => {
    // The dock key is the relative reference; the server needs the absolute
    // path stored at upload time to delete the file.
    const meta = metaFor(sessionId).get(ref)
    metaFor(sessionId).delete(ref)
    notifyMeta()
    if (meta === undefined) return
    // Still in flight: abort it. No reference was inserted and a user cancel
    // must not surface as an error.
    if (meta.status === 'uploading') {
      meta.abort?.()
      return
    }
    if (meta.status !== 'ready' || meta.absolutePath === undefined) return
    void fetch('/api/upload', {
      method: 'DELETE',
      headers: {
        'x-session-id': sessionId,
        'x-file-path': meta.absolutePath
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
              <div key={ref} className={`dsh-upload-card${meta.status === 'error' ? ' dsh-upload-card-error' : ''}`}>
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
                <div className="dsh-upload-name" title={meta.error ?? meta.name}>
                  {meta.name}
                </div>
                <div className="dsh-upload-size">{cardCaption(meta, t)}</div>
                {meta.status === 'uploading' && (
                  <div className="dsh-upload-progress">
                    <div
                      className="dsh-upload-progress-fill"
                      style={{ width: `${Math.round((meta.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                )}
                <Tooltip label={meta.status === 'uploading' ? t('card.cancel') : t('card.remove')}>
                  <button
                    type="button"
                    className="dsh-upload-remove"
                    aria-label={meta.status === 'uploading' ? t('card.cancel') : t('card.remove')}
                    onClick={() => removeCard(ref)}
                  >
                    <IconCloseOutlineRegular size={12} />
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
            aria-label={t('card.close')}
            onClick={() => setError(null)}
          >
            <IconCloseOutlineRegular size={12} />
          </button>
        </div>
      )}
      <DragOverlay attach={attach} t={t} />
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
  locale: {
    /** Register a namespace's dictionaries, all locales in one call; returns a disposer. */
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    /** Bind a namespace to a translate function reading the active locale at call time. */
    bind(ns: string): Translator
  }
}): void {
  // Stylesheet lives in the plugin's fiber: removed when the client half stops.
  ctx.effect(() => injectCss())
  // Dictionaries live in the plugin's fiber too: a stopped client half must not
  // leave a namespace behind for the next mount to collide with.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  // Bound once for the non-component paths (upload errors, auto-inserted image
  // copy); the components get the framework's live `t` through `locale: NS`.
  const t = ctx.locale.bind(NS)
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: '@',
      name: SOURCE_NAME,
      // Codex-style: pick an already-uploaded file by its relative path.
      candidates: async (projection: { sessionId: string }) => {
        const metas = uploadMetaBySession.get(projection.sessionId)
        if (metas === undefined) return []
        // Only stored files can be referenced; an in-flight upload has no
        // server-side path yet.
        return Array.from(metas.entries())
          .filter(([, meta]) => meta.status === 'ready')
          .map(([ref, meta]) => ({
            name: ref,
            description: `${meta.label} · ${formatBytes(meta.bytes)}`,
            icon: '📎'
          }))
      },
      onPick: (pick: {
        candidate: { name: string }
        session: { sessionId: string }
      }): { insert: { source: string; ref: string; label: string; clipboardText: string } } | undefined => {
        const metas = uploadMetaBySession.get(pick.session.sessionId)
        const meta = metas?.get(pick.candidate.name)
        if (metas === undefined || meta === undefined) return undefined
        return {
          insert: {
            source: SOURCE_NAME,
            ref: pick.candidate.name,
            label: meta.name,
            clipboardText: `@${pick.candidate.name}`
          }
        }
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
        locale: NS,
        inject: (sessionId: string) => ({
          attach: (files: File[]) => attachFiles(ctx.sessions.scope(sessionId), files, sessionId, t)
        })
      },
      UploadButton
    )
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-file-upload-dock',
        order: 5,
        locale: NS,
        inject: (sessionId: string) => ({
          attach: (files: File[]) => attachFiles(ctx.sessions.scope(sessionId), files, sessionId, t)
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
    inject: ['slots', 'inputTriggers', 'sessions', 'locale']
  }
}
