/** Audio transcription via an OpenAI-compatible ASR endpoint
 * (`POST /audio/transcriptions`, multipart form with `file` + `model`).
 * Used for uploaded audio files when `asrEndpoint` is configured; the
 * endpoint key comes from an env var via the standard credentials seam.
 */

import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'

export interface AsrOptions {
  /** OpenAI-compatible endpoint, e.g. https://api.openai.com/v1/audio/transcriptions */
  endpoint: string
  /** Env var holding the API key. */
  apiKeyEnv: string
  /** Model name, e.g. whisper-1 */
  model: string
  /** Request timeout in ms. */
  timeoutMs?: number
}

/** Multipart form-data body for the transcription request. */
function buildForm(filePath: string, model: string): { body: Buffer; boundary: string } {
  const boundary = `----dsh-file-upload-${Date.now().toString(36)}`
  const fileBytes = readFileSync(filePath)
  const name = filePath.slice(filePath.lastIndexOf('/') + 1) || 'audio'
  const parts: Buffer[] = []
  parts.push(Buffer.from(`--${boundary}\r\n`))
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${name}"\r\n`))
  parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`))
  parts.push(fileBytes)
  parts.push(Buffer.from(`\r\n--${boundary}\r\n`))
  parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), boundary }
}

/**
 * Transcribe an audio file with an OpenAI-compatible endpoint.
 * Returns the transcript text; throws on failure (callers degrade to a
 * plain file attachment).
 */
export async function transcribeAudio(
  filePath: string,
  options: AsrOptions
): Promise<string> {
  const { body, boundary } = buildForm(filePath, options.model)
  const apiKey = process.env[options.apiKeyEnv] ?? ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000)
  try {
    const res = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body,
      signal: controller.signal
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`ASR HTTP ${res.status}: ${detail}`)
    }
    const payload = (await res.json()) as { text?: string } | { transcript?: string }
    const text = 'text' in payload ? payload.text : 'transcript' in payload ? payload.transcript : undefined
    if (typeof text !== 'string' || text === '') {
      throw new Error('ASR response missing text')
    }
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

/** Check whether an audio file is small enough to transcribe inline. */
export function audioSizeOk(filePath: string, maxBytes: number): boolean {
  try {
    return statSync(filePath).size <= maxBytes
  } catch {
    return false
  }
}
