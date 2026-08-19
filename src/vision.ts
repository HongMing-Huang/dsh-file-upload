/** Image description ("讲解图片") via an OpenAI-compatible vision endpoint.
 *
 * Mature design, endpoint auto-discovery chain:
 *   1. explicit `visionEndpoint` + `visionModel` configuration;
 *   2. local Ollama auto-detected (http://localhost:11434) — picks the first
 *      vision-capable model (e.g. a locally deployed DeepSeek-VL2 or
 *      qwen2.5-vl) — zero config, images never leave the machine;
 *   3. standard OpenAI endpoint with a key resolved from the dsh credentials
 *      seam (inherited env → $DSH_HOME/.credentials.yaml → project .env).
 *
 * The description travels with the message, so a text-only model (like the
 * DeepSeek API) can reason about the image content.
 */

import { readFileSync, statSync } from 'node:fs'

export interface VisionOptions {
  /** Explicit endpoint override ('' = auto-discovery). */
  endpoint: string
  /** Explicit model override ('' = auto). */
  model: string
  /** Credential reference name resolved via dsh credentials. */
  apiKeyEnv: string
  /** Resolver for the API key (dsh credentials seam). */
  resolveKey: () => Promise<string>
  /** Request timeout in ms. */
  timeoutMs?: number
  /** Max image bytes accepted (default 10 MB). */
  maxBytes?: number
}

interface VisionTarget {
  endpoint: string
  model: string
  apiKey: string
}

/** Probe local Ollama and return the first vision-capable model, if any. */
async function detectLocalOllama(): Promise<VisionTarget | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch('http://localhost:11434/v1/models', { signal: controller.signal })
      if (!res.ok) return null
      const payload = (await res.json()) as { data?: Array<{ id: string }> }
      const models = payload.data ?? []
      // Vision-capable heuristics: known VL model names.
      const vision = models.find((m) => /vl|vision|llava|moondream|gemma3|internvl/i.test(m.id))
      if (vision === undefined) return null
      return { endpoint: 'http://localhost:11434/v1/chat/completions', model: vision.id, apiKey: 'ollama' }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** Resolve the effective vision target via the discovery chain. */
async function resolveTarget(options: VisionOptions): Promise<VisionTarget> {
  if (options.endpoint !== '') {
    return { endpoint: options.endpoint, model: options.model !== '' ? options.model : 'gpt-4o-mini', apiKey: await options.resolveKey() }
  }
  const ollama = await detectLocalOllama()
  if (ollama !== null) return ollama
  const key = await options.resolveKey()
  if (key !== '') {
    return {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: options.model !== '' ? options.model : 'gpt-4o-mini',
      apiKey: key
    }
  }
  throw new Error('vision: no endpoint available (configure visionEndpoint or start local Ollama with a VL model, or set a vision API key)')
}

function imageDataUrl(filePath: string): string {
  const data = readFileSync(filePath)
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const mime =
    ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${data.toString('base64')}`
}

/**
 * Generate a description ("讲解") of an image. Throws on failure; callers
 * degrade to path-only references.
 */
export async function describeImage(filePath: string, options: VisionOptions): Promise<string> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  if (statSync(filePath).size > maxBytes) {
    throw new Error(`vision: image exceeds ${maxBytes} bytes`)
  }
  const target = await resolveTarget(options)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (target.apiKey !== '' && target.apiKey !== 'ollama') headers.authorization = `Bearer ${target.apiKey}`
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: target.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '请详细描述这张图片的内容,包括图中出现的文字。用用户使用的语言回答(如果无法判断则用中文)。'
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
