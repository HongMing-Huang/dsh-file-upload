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
import { join, relative, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sniff } from './detect.ts'
import type { SniffResult } from './detect.ts'
import { decodeText } from './convert.ts'

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
  /** Byte cap for one inline text payload returned to the client. */
  inlineTextLimit: number
  /** Byte cap for the preview returned to the client. */
  previewTextLimit: number
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

export function createUploadHandler(options: UploadOptions) {
  const {
    maxBytes,
    allowedExtensions,
    ttlMs,
    maxConcurrent,
    sessionCwd,
    defaultDir,
    inlineTextLimit,
    previewTextLimit,
    now = () => Date.now()
  } = options

  let inflight = 0

  async function storageDirFor(req: IncomingMessage): Promise<{ dir: string; sessionId: string; cwd: string } | null> {
    const raw = req.headers['x-session-id']
    const sessionId = typeof raw === 'string' ? sanitizeSessionId(raw) : 'anonymous'
    if (sessionCwd !== undefined) {
      const cwd = await sessionCwd(sessionId)
      if (cwd === undefined) return null
      return { dir: join(cwd, '.dsh-uploads', sessionId), sessionId, cwd }
    }
    return { dir: join(defaultDir, '.dsh-uploads', sessionId), sessionId, cwd: defaultDir }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const storage = await storageDirFor(req)
    if (storage === null) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown session' }))
      return
    }
    if (inflight >= maxConcurrent) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'too many concurrent uploads' }))
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'payload too large' }))
      return
    }
    inflight += 1
    try {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > maxBytes) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          return
        }
        chunks.push(buf)
      }
      if (total === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'empty upload' }))
        return
      }
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
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `extension ".${ext}" not allowed` }))
        return
      }
      const data = Buffer.concat(chunks)
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

      const meta: UploadedMeta = {
        path: dest,
        name,
        bytes: data.length,
        sessionId: storage.sessionId,
        sniff: sniffResult,
        ...(deduplicated ? { deduplicated: true } : {})
      }

      const relativePath = relPath !== '' ? relPath : relative(storage.cwd, dest).split(sep).join('/')

      // Images: report how the agent should read them — natively via the
      // official read_image tool (multimodal route or a vision bridge like
      // dsh-vision-proxy, which our route gate detects automatically) or,
      // for text-only routes, generate an automatic image description
      // ("讲解图片") through the vision discovery chain so the text-only
      // model can reason about the image.
      if (sniffResult.type === 'image' && options.imageMode !== undefined) {
        try {
          meta.imageMode = await options.imageMode(storage.sessionId)
          if (meta.imageMode === 'ocr' && options.vision !== undefined) {
            meta.imageDescription = await options.vision(dest, meta.name)
          }
        } catch (err) {
          meta.imageMode = 'ocr'
          console.warn(`[dsh-file-upload] image description failed for ${name}:`, err instanceof Error ? err.message : String(err))
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
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
        })
      )
    } catch (err) {
      console.error('[dsh-file-upload] upload persist failed:', err)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'write failed' }))
    } finally {
      inflight -= 1
    }
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const storage = await storageDirFor(req)
    if (storage === null) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown session' }))
      return
    }
    const raw = req.headers['x-file-path']
    const filePath = typeof raw === 'string' ? raw : ''
    if (filePath === '' || !filePath.startsWith(storage.dir)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid path' }))
      return
    }
    try {
      await rm(filePath, { force: true })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      console.error('[dsh-file-upload] delete failed:', err)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'delete failed' }))
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    if (!LOOPBACK_HOST.test(host)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'loopback only' }))
      return
    }
    if (req.method === 'POST') return handlePost(req, res)
    if (req.method === 'DELETE') return handleDelete(req, res)
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
  }
}

/**
 * Periodically remove upload directories older than the TTL. Scans multiple
 * roots: the fallback `defaultDir` plus every session workspace's
 * `.dsh-uploads` directory (resolved live each sweep), so files stored under
 * session cwds are swept too — not just the no-session fallback root.
 */
export function createSweeper(
  roots: Array<string | (() => string | undefined)>,
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
          const root = typeof rootEntry === 'function' ? rootEntry() : rootEntry
          if (root === undefined || seen.has(root)) continue
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
      } catch (err) {
        console.error('[dsh-file-upload] sweep failed:', err)
      }
    })()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
