import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transcribeAudio } from '../src/asr.ts'

function startMockAsr(): Promise<{ server: ReturnType<typeof createServer>; url: string; receivedAuth: () => string | null }> {
  let receivedAuth: string | null = null
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? null
    receivedAuth = auth
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const isMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/form-data')
      const hasFile = body.includes(Buffer.from('name="file"'))
      if (isMultipart && hasFile) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: 'hello from mock asr' }))
      } else {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad request' }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/v1/audio/transcriptions`, receivedAuth: () => receivedAuth })
    })
  })
}

test('transcribeAudio: posts multipart and returns transcript text', async () => {
  const { server, url, receivedAuth } = await startMockAsr()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dshfu-asr-'))
    const wav = join(dir, 'voice.wav')
    writeFileSync(wav, Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))

    const text = await transcribeAudio(wav, {
      endpoint: url,
      apiKey: 'sk-test-123',
      model: 'whisper-1',
      timeoutMs: 15000
    })
    assert.equal(text, 'hello from mock asr')
    assert.equal(receivedAuth(), 'Bearer sk-test-123')
  } finally {
    server.close()
  }
})

test('transcribeAudio: rejects on connection failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-asr-'))
  const wav = join(dir, 'voice.wav')
  writeFileSync(wav, Buffer.from('fake audio'))
  // Port 1 refuses connections → fetch rejects → transcribeAudio rejects.
  await assert.rejects(() =>
    transcribeAudio(wav, { endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions', apiKey: 'k', model: 'm', timeoutMs: 5000 })
  )
})
