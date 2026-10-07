// Upload HTTP surface. Security model mirrors the official plugin contract:
//   - loopback-only host, same-origin and same-site checks
//   - files land in a per-session directory under the session's own cwd
//     (`.dsh-uploads/<sessionId>`), so the agent's fs backend can always
//     resolve them and storage is isolated between sessions
//   - sanitized file names, size cap, optional extension allowlist, sha256
//     content dedup, bounded concurrency, TTL sweep
//   - content is sniffed at upload time; small text files return their text
//     inline so the client can drop it straight into the composer
//     (Claude-desktop-style), larger text returns a preview, and documents
//     (PDF/DOCX/XLSX) are read lazily via read_document with conversion cache.

import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sniff } from './detect.ts'
import type { SniffResult } from './detect.ts'

export interface UploadOptions {
  /** Byte cap for one upload body. */
  maxBytes: number
  /** Lowercase extension allowlist; empty array means every extension is allowed. */
  allowedExtensions: string[]
  /** How long an uploaded file may live before the sweep removes it. */
  ttlMs: number
  /** Sweep interval; 0 disables the periodic sweep. */
  sweepIntervalMs: number
  /** Concurrent upload bodies admitted at once. */
  maxConcurrent: number
  /**
   * Resolve a session id to its workspace cwd. When the resolver exists but
   * returns undefined the request is rejected (unauthenticated session);
   * when the resolver is absent (no sessions service injected) requests fall
   * back to `defaultDir`.
   */
  sessionCwd?: (sessionId: string) => string | undefined | Promise<string | undefined>
  /** Fallback storage root when no sessions service is available. */
  defaultDir: string
  /**
   * Resolve whether the session's routed model accepts image input.
   * `'native'` → the agent reads images with the official `read_image` tool;
   * `'ocr'` → a visual description is generated via `vision`.
   */
  imageMode?: (sessionId: string) => Promise<'native' | 'ocr'>
  /** Generate a text description ("讲解") of an image for text-only routes. */
  vision?: (filePath: string, name: string) => Promise<string>
  now?: () => number
}

export interface UploadedMeta {
  path: string
  name: string
  bytes: number
  sessionId: string
  sniff: SniffResult
  imageMode?: 'native' | 'ocr'
  imageDescription?: string
  deduplicated?: boolean
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** Control chars, path separators, dot segments and leading dots stripped. */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '')
  const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..')
  const name = segments.join('_').replace(/^\.+/, '').trim().slice(0, 120)
  return name === '' ? 'upload.bin' : name
}

/** Sanitize a relative path for display: strip absolute prefixes, dot segments, control chars. */
export function sanitizeRelativePath(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '')
  const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..')
  if (segments.length === 0) return ''
  return segments.join('/').slice(0, 240)
}

/** Session ids are opaque tokens; still constrain them to a safe alphabet. */
export function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)
  return cleaned === '' ? 'anonymous' : cleaned
}

/** Per-session storage location plus the cwd that relative paths are shown from. */
interface UploadStorage {
  dir: string
  sessionId: string
  cwd: string
}

/**
 * What the request handlers need that used to live inside the
 * `createUploadHandler` closure: the options plus the one piece of mutable
 * state (`inflight`). Passing it explicitly keeps the steps below as named
 * module-level functions while they still share a single counter per handler.
 */
interface UploadContext {
  maxBytes: number
  allowedExtensions: string[]
  maxConcurrent: number
  sessionCwd: UploadOptions['sessionCwd']
  defaultDir: string
  imageMode: UploadOptions['imageMode']
  vision: UploadOptions['vision']
  /** Slots held by the body read + persist phase only, never by the vision call. */
  inflight: number
}

/** A persisted upload plus the reference the model is given for it. */
interface PersistedUpload {
  meta: UploadedMeta
  relativePath: string
}

/** Every exit path in this module answers through here. */
function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Machine-readable codes for the failures a browser can surface in the upload
 * flow. The client renders these through its locale dictionaries
 * (`error.<code>`), so the list and the dictionaries are checked against each
 * other by a test; the `error` prose stays beside the code as the fallback for
 * readers that do not know codes.
 */
export const UPLOAD_ERROR_CODES = [
  'payloadTooLarge',
  'emptyUpload',
  'unknownSession',
  'tooManyUploads',
  'extensionNotAllowed',
  'writeFailed',
  'loopbackOnly'
] as const

/** Resolve the session's own upload directory; null means the session is unknown. */
async function storageDirFor(ctx: UploadContext, req: IncomingMessage): Promise<UploadStorage | null> {
  const raw = req.headers['x-session-id']
  const sessionId = typeof raw === 'string' ? sanitizeSessionId(raw) : 'anonymous'
  if (ctx.sessionCwd !== undefined) {
    const cwd = await ctx.sessionCwd(sessionId)
    if (cwd === undefined) return null
    return { dir: join(cwd, '.dsh-uploads', sessionId), sessionId, cwd }
  }
  return { dir: join(ctx.defaultDir, '.dsh-uploads', sessionId), sessionId, cwd: ctx.defaultDir }
}

/**
 * Step 1 — receive: drain the body while enforcing the cumulative cap, then
 * reject an empty upload. Both rejections answer here so the orchestrator only
 * has to check `ok`. A socket error is deliberately not caught: it must reach
 * the caller's catch block, where the disconnect semantics live.
 */
async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number
): Promise<{ ok: true; data: Buffer } | { ok: false }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      respond(res, 413, { error: 'payload too large', code: 'payloadTooLarge' })
      return { ok: false }
    }
    chunks.push(buf)
  }
  if (total === 0) {
    respond(res, 400, { error: 'empty upload', code: 'emptyUpload' })
    return { ok: false }
  }
  return { ok: true, data: Buffer.concat(chunks) }
}

/**
 * Step 2 — validate: decode `x-file-name` / `x-file-relpath`, sanitize both and
 * apply the extension allowlist. A rejected extension comes back in the prose
 * and as `params.ext`, so a client that renders the code still gets the value.
 */
function resolveUploadName(
  req: IncomingMessage,
  allowedExtensions: string[]
): { ok: true; name: string; relPath: string } | { ok: false; ext: string } {
  let rawName = 'upload.bin'
  try {
    const header = String(req.headers['x-file-name'] ?? '')
    if (header !== '') rawName = decodeURIComponent(header)
  } catch {
    // fall through to the default name
  }
  let relPath = ''
  try {
    const relHeader = String(req.headers['x-file-relpath'] ?? '')
    if (relHeader !== '') relPath = sanitizeRelativePath(decodeURIComponent(relHeader))
  } catch {
    // fall through
  }
  const name = sanitizeFileName(rawName)
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (allowedExtensions.length > 0 && !allowedExtensions.includes(ext)) {
    return { ok: false, ext }
  }
  return { ok: true, name, relPath }
}

/**
 * Step 3 — persist: sniff, hash-dedup write with `wx`, then honor a disconnect
 * that landed while the bytes were being written. Returns null when the file
 * was (or must be) taken back, so the caller stops without answering.
 */
async function persistUpload(
  storage: UploadStorage,
  data: Buffer,
  name: string,
  relPath: string,
  clientGone: () => boolean
): Promise<PersistedUpload | null> {
  const sniffResult = sniff(data, name)
  await mkdir(storage.dir, { recursive: true })
  const digest = createHash('sha256').update(data).digest('hex').slice(0, 16)
  const dest = join(storage.dir, `${digest}-${name}`)
  let deduplicated = false
  try {
    await writeFile(dest, data, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') deduplicated = true
    else throw err
  }

  // The disconnect landed while the bytes were being written, so the
  // response can no longer be delivered: take the file back instead of
  // leaving an orphan. A deduplicated file already served an earlier
  // successful upload and is left in place.
  if (clientGone()) {
    if (!deduplicated) await rm(dest, { force: true })
    return null
  }

  const meta: UploadedMeta = {
    path: dest,
    name,
    bytes: data.length,
    sessionId: storage.sessionId,
    sniff: sniffResult,
    ...(deduplicated ? { deduplicated: true } : {})
  }
  const relativePath = relPath !== '' ? relPath : relative(storage.cwd, dest).split(sep).join('/')
  return { meta, relativePath }
}

/**
 * The optional slow step for images: report how the agent should read them —
 * natively via the official read_image tool (multimodal route or a vision
 * bridge like dsh-vision-proxy, which our route gate detects automatically) or,
 * for text-only routes, generate an automatic image description ("讲解图片")
 * through the vision discovery chain so the text-only model can reason about
 * the image. Runs outside the concurrency gate: the slot is already released
 * when this slow call starts.
 */
async function describeImageIfNeeded(meta: UploadedMeta, ctx: UploadContext): Promise<void> {
  if (meta.sniff.type !== 'image' || ctx.imageMode === undefined) return
  try {
    meta.imageMode = await ctx.imageMode(meta.sessionId)
    if (meta.imageMode === 'ocr' && ctx.vision !== undefined) {
      meta.imageDescription = await ctx.vision(meta.path, meta.name)
    }
  } catch (err) {
    meta.imageMode = 'ocr'
    console.warn(`[dsh-file-upload] image description failed for ${meta.name}:`, err instanceof Error ? err.message : String(err))
  }
}

/** Step 4 — respond: the 200 JSON shape (optional keys appear only when set). */
function buildUploadResponse(meta: UploadedMeta, relativePath: string): Record<string, unknown> {
  return {
    path: meta.path,
    relativePath,
    name: meta.name,
    bytes: meta.bytes,
    sessionId: meta.sessionId,
    sniffedType: meta.sniff.type,
    label: meta.sniff.label,
    ...(meta.imageMode !== undefined ? { imageMode: meta.imageMode } : {}),
    ...(meta.imageDescription !== undefined ? { imageDescription: meta.imageDescription } : {}),
    ...(meta.deduplicated ? { deduplicated: true } : {})
  }
}

/** POST /api/upload — orchestrates receive → validate → persist → respond. */
async function handlePost(ctx: UploadContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const storage = await storageDirFor(ctx, req)
  if (storage === null) {
    respond(res, 403, { error: 'unknown session', code: 'unknownSession' })
    return
  }
  if (ctx.inflight >= ctx.maxConcurrent) {
    respond(res, 429, { error: 'too many concurrent uploads', code: 'tooManyUploads' })
    return
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > ctx.maxBytes) {
    respond(res, 413, { error: 'payload too large', code: 'payloadTooLarge' })
    return
  }
  // The slot covers only the body read + disk write below. The image
  // explanation call (`imageMode` + `vision`, up to 60s) runs after the slot
  // is released, so a few slow images cannot starve document uploads.
  ctx.inflight += 1
  // A browser that goes away mid-upload (user cancelled, tab closed) must not
  // leave the bytes it managed to send behind as an orphan file. `close` also
  // fires after a normal response, so only an unfinished response counts as a
  // disconnect; the abort-mid-body case already surfaces as a read error.
  let gone = false
  const onClientClose = (): void => {
    if (!res.writableFinished) gone = true
  }
  res.on('close', onClientClose)
  const clientGone = (): boolean => gone || (res.destroyed && !res.writableFinished)
  let persisted: PersistedUpload | null = null
  try {
    const body = await readBody(req, res, ctx.maxBytes)
    if (!body.ok) return
    const resolved = resolveUploadName(req, ctx.allowedExtensions)
    if (!resolved.ok) {
      respond(res, 415, {
        error: `extension ".${resolved.ext}" not allowed`,
        code: 'extensionNotAllowed',
        params: { ext: resolved.ext }
      })
      return
    }
    // The client is already gone: stop here so a cancelled upload never
    // reaches the disk at all.
    if (clientGone()) return
    persisted = await persistUpload(storage, body.data, resolved.name, resolved.relPath, clientGone)
  } catch (err) {
    // A cancelled upload surfaces here as a read error. Nothing was written
    // and there is nobody left to answer, so it is not a server failure.
    if (!clientGone()) {
      console.error('[dsh-file-upload] upload persist failed:', err)
      respond(res, 500, { error: 'write failed', code: 'writeFailed' })
    }
  } finally {
    ctx.inflight -= 1
    res.off('close', onClientClose)
  }
  if (persisted === null) return
  const { meta, relativePath } = persisted

  await describeImageIfNeeded(meta, ctx)

  // The explanation above runs outside the concurrency gate and can take up
  // to a minute, so the browser may well have cancelled by now. Same data
  // hygiene: a response nobody can read must not leave the file behind.
  if (clientGone()) {
    if (meta.deduplicated !== true) await rm(meta.path, { force: true })
    return
  }

  respond(res, 200, buildUploadResponse(meta, relativePath))
}

/** DELETE /api/upload — removes one file, but only inside the session directory. */
async function handleDelete(ctx: UploadContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const storage = await storageDirFor(ctx, req)
  if (storage === null) {
    respond(res, 403, { error: 'unknown session', code: 'unknownSession' })
    return
  }
  const raw = req.headers['x-file-path']
  const filePath = typeof raw === 'string' ? raw : ''
  // Normalize both sides before comparing: `..`, duplicate separators and a
  // trailing slash must not slip past the guard. The target has to be the
  // session directory itself or live below it with a real path separator —
  // a bare string prefix would also match siblings like `<session>-evil`.
  const dir = resolve(storage.dir)
  const target = filePath === '' ? '' : resolve(filePath)
  if (target === '' || (target !== dir && !target.startsWith(dir + sep))) {
    respond(res, 400, { error: 'invalid path' })
    return
  }
  try {
    await rm(target, { force: true })
    respond(res, 200, { ok: true })
  } catch (err) {
    console.error('[dsh-file-upload] delete failed:', err)
    respond(res, 500, { error: 'delete failed' })
  }
}

export function createUploadHandler(options: UploadOptions) {
  const ctx: UploadContext = {
    maxBytes: options.maxBytes,
    allowedExtensions: options.allowedExtensions,
    maxConcurrent: options.maxConcurrent,
    sessionCwd: options.sessionCwd,
    defaultDir: options.defaultDir,
    imageMode: options.imageMode,
    vision: options.vision,
    inflight: 0
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    if (!LOOPBACK_HOST.test(host)) {
      respond(res, 403, { error: 'loopback only', code: 'loopbackOnly' })
      return
    }
    if (req.method === 'POST') return handlePost(ctx, req, res)
    if (req.method === 'DELETE') return handleDelete(ctx, req, res)
    respond(res, 405, { error: 'method not allowed' })
  }
}

/**
 * Periodically remove upload directories older than the TTL. Scans multiple
 * roots: the fallback `defaultDir` plus every session workspace's
 * `.dsh-uploads` directory (resolved live each sweep), so files stored under
 * session cwds are swept too — not just the no-session fallback root.
 * A root entry may be a path or a resolver returning one path, several paths
 * (e.g. every active session cwd) or nothing at all.
 */
export function createSweeper(
  roots: Array<string | (() => string | readonly (string | undefined)[] | undefined)>,
  ttlMs: number,
  intervalMs: number,
  now: () => number = Date.now
): () => void {
  if (intervalMs <= 0) return () => undefined
  const timer = setInterval(() => {
    void (async () => {
      try {
        const seen = new Set<string>()
        for (const rootEntry of roots) {
          const raw = typeof rootEntry === 'function' ? rootEntry() : rootEntry
          const candidates = typeof raw === 'string' ? [raw] : raw ?? []
          for (const root of candidates) {
            if (root === undefined || root === '' || seen.has(root)) continue
            seen.add(root)
            const uploadRoot = join(root, '.dsh-uploads')
            const sessionDirs = await readdir(uploadRoot).catch(() => [])
            for (const sessionDir of sessionDirs) {
              const dir = join(uploadRoot, sessionDir)
              const info = await stat(dir).catch(() => null)
              if (info === null) continue
              if (now() - info.mtimeMs > ttlMs) {
                await rm(dir, { recursive: true, force: true })
              }
            }
          }
        }
      } catch (err) {
        console.error('[dsh-file-upload] sweep failed:', err)
      }
    })()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
