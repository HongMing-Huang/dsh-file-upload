import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUploadHandler } from '../src/upload.ts'
import type { UploadOptions } from '../src/upload.ts'

interface UploadServer {
  server: ReturnType<typeof createServer>
  url: string
  port: number
  dir: string
  /** Resolves once at least one request has been handled and none is in flight. */
  idle: () => Promise<void>
  /** Resolves when the server starts handling its next request. */
  nextRequest: () => Promise<void>
}

function startUploadServer(overrides: Partial<UploadOptions> = {}): Promise<UploadServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-up-'))
  const handler = createUploadHandler({
    maxBytes: 1024 * 1024,
    allowedExtensions: [],
    ttlMs: 3600000,
    sweepIntervalMs: 0,
    maxConcurrent: 4,
    defaultDir: dir,
    sessionCwd: (sessionId: string) => (sessionId === 'good-session' ? join(dir, 'workspace') : undefined),
    ...overrides
  })
  let started = 0
  let active = 0
  const idleWaiters = new Set<() => void>()
  const requestWaiters = new Set<() => void>()
  const server = createServer((req, res) => {
    started += 1
    active += 1
    for (const resume of requestWaiters) resume()
    requestWaiters.clear()
    void handler(req, res).finally(() => {
      active -= 1
      if (active === 0 && started > 0) {
        for (const resume of idleWaiters) resume()
        idleWaiters.clear()
      }
    })
  })
  const idle = (): Promise<void> => {
    if (active === 0 && started > 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.add(resolve))
  }
  const nextRequest = (): Promise<void> =>
    new Promise((resolve) => {
      requestWaiters.add(resolve)
    })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, port, dir, idle, nextRequest })
    })
  })
}

/** Files stored for `good-session` (empty when the directory itself is absent). */
function storedFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'workspace', '.dsh-uploads', 'good-session'))
  } catch {
    return []
  }
}

/** A tiny-but-valid PNG signature, enough for the sniffer to report `image`. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/**
 * Start an upload whose request body stays open until `release()` is called,
 * so the request holds a concurrency slot while it is being read. `abort()`
 * simulates the browser cancelling the upload.
 */
function holdUpload(url: string, name: string): { release: () => void; abort: () => void; done: Promise<number> } {
  let release: () => void = () => undefined
  let abort: () => void = () => undefined
  let aborted = false
  const done = new Promise<number>((resolve, reject) => {
    const req = request(
      `${url}/api/upload`,
      { method: 'POST', headers: { 'x-session-id': 'good-session', 'x-file-name': name } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.flushHeaders()
    req.write('partial body')
    release = () => {
      if (!aborted) req.end(' tail')
    }
    abort = () => {
      aborted = true
      req.destroy()
    }
  })
  return { release, abort, done }
}

/** Yield to the event loop so every already-queued handler microtask has run. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve())
  })
}

test('upload handler: text file uploads with relative path reference', async () => {
  const { server, url } = await startUploadServer()
  try {
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'hello.txt' },
      body: 'hello upload'
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { path: string; name: string; sniffedType: string; relativePath?: string; inlineText?: string }
    assert.equal(body.name, 'hello.txt')
    assert.equal(body.sniffedType, 'text')
    assert.equal(body.inlineText, undefined, 'no content inlining — Codex-style reference only')
    assert.equal(typeof body.relativePath, 'string')
    assert.match(body.path, /\.dsh-uploads[/\\]good-session/)
  } finally {
    server.close()
  }
})

test('upload handler: code file uploads as reference (no inlining)', async () => {
  const { server, url } = await startUploadServer()
  try {
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'code.js' },
      body: 'const a = 1;\n'
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { sniffedType: string; inlineText?: string; relativePath?: string }
    assert.equal(body.sniffedType, 'text')
    assert.equal(body.inlineText, undefined)
    assert.equal(typeof body.relativePath, 'string')
  } finally {
    server.close()
  }
})

test('upload handler: unknown session rejected 403', async () => {
  const { server, url } = await startUploadServer()
  try {
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'nope', 'x-file-name': 'x.txt' },
      body: 'x'
    })
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})

test('upload handler: oversized payload rejected 413', async () => {
  const { server, url } = await startUploadServer()
  try {
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'big.bin' },
      body: new Uint8Array(2 * 1024 * 1024)
    })
    assert.equal(res.status, 413)
  } finally {
    server.close()
  }
})

test('upload handler: DELETE removes stored file', async () => {
  const { server, url } = await startUploadServer()
  try {
    const up = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'del.txt' },
      body: 'to delete'
    })
    const body = (await up.json()) as { path: string }
    assert.equal(existsSync(body.path), true)
    const del = await fetch(`${url}/api/upload`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'good-session', 'x-file-path': body.path }
    })
    assert.equal(del.status, 200)
    assert.equal(existsSync(body.path), false, 'stored file must be gone')
  } finally {
    server.close()
  }
})

test('upload handler: DELETE refuses a sibling directory that shares the session prefix', async () => {
  const { server, url, dir } = await startUploadServer()
  try {
    const sibling = join(dir, 'workspace', '.dsh-uploads', 'good-session-evil')
    mkdirSync(sibling, { recursive: true })
    const res = await fetch(`${url}/api/upload`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'good-session', 'x-file-path': sibling }
    })
    assert.equal(res.status, 400)
    assert.equal(existsSync(sibling), true, 'sibling directory must survive')
  } finally {
    server.close()
  }
})

test('upload handler: DELETE refuses a sibling file that shares the session prefix', async () => {
  const { server, url, dir } = await startUploadServer()
  try {
    const sibling = join(dir, 'workspace', '.dsh-uploads', 'good-session-evil.txt')
    mkdirSync(join(dir, 'workspace', '.dsh-uploads'), { recursive: true })
    writeFileSync(sibling, 'not yours')
    const res = await fetch(`${url}/api/upload`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'good-session', 'x-file-path': sibling }
    })
    assert.equal(res.status, 400)
    assert.equal(existsSync(sibling), true, 'sibling file must survive')
  } finally {
    server.close()
  }
})

test('upload handler: DELETE refuses a path that escapes the session directory', async () => {
  const { server, url, dir } = await startUploadServer()
  try {
    const sessionDir = join(dir, 'workspace', '.dsh-uploads', 'good-session')
    mkdirSync(sessionDir, { recursive: true })
    const outside = join(dir, 'workspace', 'secret.txt')
    writeFileSync(outside, 'keep me')
    const res = await fetch(`${url}/api/upload`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'good-session', 'x-file-path': `${sessionDir}/../../secret.txt` }
    })
    assert.equal(res.status, 400)
    assert.equal(existsSync(outside), true, 'path outside the session directory must survive')
  } finally {
    server.close()
  }
})

test('upload handler: concurrency gate still rejects the fifth in-flight upload', async () => {
  const { server, url } = await startUploadServer()
  let seen = 0
  let signal: () => void = () => undefined
  const fourSeen = new Promise<void>((resolve) => {
    signal = resolve
  })
  server.on('request', () => {
    seen += 1
    if (seen === 4) signal()
  })
  const held = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => holdUpload(url, name))
  try {
    await fourSeen
    await tick() // let the four handlers take their slot (they run before the next macrotask)
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'fifth.txt' },
      body: 'fifth'
    })
    assert.equal(res.status, 429)
    const body = (await res.json()) as { error: string }
    assert.equal(body.error, 'too many concurrent uploads')
  } finally {
    for (const entry of held) entry.release()
    const statuses = await Promise.all(held.map((entry) => entry.done))
    for (const status of statuses) assert.equal(status, 200)
    server.close()
  }
})

test('upload handler: slow image explanation does not hold a concurrency slot', async () => {
  let started = 0
  let releaseVision: () => void = () => undefined
  const visionGate = new Promise<void>((resolve) => {
    releaseVision = resolve
  })
  let signal: () => void = () => undefined
  const fourStarted = new Promise<void>((resolve) => {
    signal = resolve
  })
  const { server, url } = await startUploadServer({
    imageMode: async () => 'ocr',
    vision: async () => {
      started += 1
      if (started === 4) signal()
      await visionGate
      return '一张图片'
    }
  })
  const images = [0, 1, 2, 3].map((i) =>
    fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': `pic-${i}.png` },
      body: PNG_BYTES
    })
  )
  try {
    await fourStarted // all four vision calls are in flight and blocked
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'plain.txt' },
      body: 'not an image'
    })
    assert.equal(res.status, 200, 'a document upload must not be blocked by slow image explanations')
    releaseVision()
    for (const pending of images) {
      const done = await pending
      assert.equal(done.status, 200)
      const body = (await done.json()) as { imageMode?: string; imageDescription?: string }
      assert.equal(body.imageMode, 'ocr')
      assert.equal(body.imageDescription, '一张图片')
    }
  } finally {
    releaseVision()
    await Promise.allSettled(images)
    server.close()
  }
})

test('upload handler: extension outside the allowlist rejected 415', async () => {
  const { server, url } = await startUploadServer({ allowedExtensions: ['txt'] })
  try {
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'payload.exe' },
      body: 'MZ'
    })
    assert.equal(res.status, 415)
    const body = (await res.json()) as { error: string }
    assert.equal(body.error, 'extension ".exe" not allowed')
  } finally {
    server.close()
  }
})

test('upload handler: disconnect mid-body leaves no partial file', async () => {
  const { server, url, dir, idle, nextRequest } = await startUploadServer()
  const seen = nextRequest()
  try {
    await new Promise<void>((resolve) => {
      const req = request(`${url}/api/upload`, {
        method: 'POST',
        headers: { 'x-session-id': 'good-session', 'x-file-name': 'partial.txt', 'content-length': String(1024 * 1024) }
      })
      req.on('error', () => undefined)
      req.on('close', () => resolve())
      req.flushHeaders()
      req.write('partial body')
      setTimeout(() => req.destroy(), 20)
    })
    await seen // the server really started handling it
    await idle()
    assert.deepEqual(storedFiles(dir), [], 'an aborted body read must not leave a file behind')
  } finally {
    server.close()
  }
})

test('upload handler: disconnect after the body arrives leaves no orphan file', async () => {
  const { server, url, dir, idle, nextRequest } = await startUploadServer()
  const seen = nextRequest()
  try {
    const body = Buffer.from(`orphan-check-${process.pid}-`.repeat(256))
    await new Promise<void>((resolve) => {
      const req = request(`${url}/api/upload`, {
        method: 'POST',
        headers: {
          'x-session-id': 'good-session',
          'x-file-name': 'orphan.txt',
          'content-length': String(body.length)
        }
      })
      req.on('error', () => undefined)
      req.on('response', (res) => res.resume())
      req.on('close', () => resolve())
      // Hand the whole body to the socket, then abort: the server received
      // everything but can no longer deliver the response, so keeping the file
      // would leak an orphan nobody can reference.
      req.write(body, () => req.destroy())
      req.end()
    })
    await seen // the server really started handling it
    await idle()
    assert.deepEqual(storedFiles(dir), [], 'a cancelled upload must not leave an orphan file')
  } finally {
    server.close()
  }
})

test('upload handler: an aborted upload releases its concurrency slot', async () => {
  const { server, url, idle } = await startUploadServer()
  let seen = 0
  let signal: () => void = () => undefined
  const fourSeen = new Promise<void>((resolve) => {
    signal = resolve
  })
  server.on('request', () => {
    seen += 1
    if (seen === 4) signal()
  })
  const held = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => holdUpload(url, name))
  const settled = Promise.allSettled(held.map((entry) => entry.done))
  try {
    await fourSeen
    await tick() // let the four handlers take their slot
    const blocked = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'blocked.txt' },
      body: 'blocked'
    })
    assert.equal(blocked.status, 429, 'the four held uploads must occupy every slot')
    for (const entry of held) entry.abort()
    await idle()
    const res = await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-session-id': 'good-session', 'x-file-name': 'after-abort.txt' },
      body: 'still accepting uploads'
    })
    assert.equal(res.status, 200, 'cancelled uploads must give their slot back')
  } finally {
    for (const entry of held) entry.release()
    await settled
    server.close()
  }
})
