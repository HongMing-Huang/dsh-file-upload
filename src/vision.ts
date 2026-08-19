/** Image description via an OpenAI-compatible vision endpoint.
 *
 * Mature fallback for text-only models: when the routed model cannot accept
 * image input, the plugin asks a vision-capable chat model to describe the
 * uploaded image, and the description travels with the message — the agent
 * "sees" the image without any OCR-quality issues.
 *
 * The API key comes from the dsh credentials seam (same convention as ASR).
 */

import { readFileSync } from 'node:fs'
import { statSync } from 'node:fs'

export interface VisionOptions {
  /** OpenAI-compatible chat completions endpoint. */
  endpoint: string
  /** Vision-capable model id, e.g. gpt-4o-mini. */
  model: string
  /** API key (resolved by the caller through ctx.credentials). */
  apiKey: string
  /** Request timeout in ms. */
  timeoutMs?: number
  /** Max image bytes accepted (default 10 MB). */
  maxBytes?: number
}

/** Data URL for the image content block (base64). */
function imageDataUrl(filePath: string): string {
  const data = readFileSync(filePath)
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const mime =
    ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${data.toString('base64')}`
}

/**
 * Ask a vision model to describe an image. Returns the description text.
 * Throws on failure; callers degrade to path-only references.
 */
export async function describeImage(filePath: string, options: VisionOptions): Promise<string> {
  if (options.apiKey === '') throw new Error('vision: no API key resolved')
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  if (statSync(filePath).size > maxBytes) {
    throw new Error(`vision: image exceeds ${maxBytes} bytes`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000)
  try {
    const res = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image in detail, including any text written in it. Reply in the language of the user if identifiable, otherwise in English.'
              },
              { type: 'image_url', image_url: { url: imageDataUrl(filePath) } }
            ]
          }
        ],
        max_tokens: 500
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`vision HTTP ${res.status}: ${detail}`)
    }
    const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = payload.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text === '') {
      throw new Error('vision response missing content')
    }
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}
