import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUploadHandler } from '../src/upload.ts'

function startUploadServer(): Promise<{ server: ReturnType<typeof createServer>; url: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-up-'))
  const handler = createUploadHandler({
    maxBytes: 1024 * 1024,
    allowedExtensions: [],
    ttlMs: 3600000,
    sweepIntervalMs: 0,
    maxConcurrent: 4,
    inlineTextLimit: 8192,
    previewTextLimit: 1024,
    defaultDir: dir,
    sessionCwd: (sessionId: string) => (sessionId === 'good-session' ? join(dir, 'workspace') : undefined)
  })
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, port })
    })
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
    const del = await fetch(`${url}/api/upload`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'good-session', 'x-file-path': body.path }
    })
    assert.equal(del.status, 200)
  } finally {
    server.close()
  }
})
