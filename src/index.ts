// dsh-file-upload — a dual-face DeepSeek Harness plugin: one cordis row, one
// apply, three capabilities:
//   1. Claude-style upload surface (webServer + web client): paperclip button
//      and drag-and-drop into the composer; files land per-session inside the
//      session workspace (.dsh-uploads/<sessionId>) where the agent's fs
//      backend can always resolve them; small text files are inlined straight
//      into the composer.
//   2. Content sniffing + document→Markdown conversion, fully bundled:
//      the markitdown-node engine (Microsoft MarkItDown TypeScript port,
//      20+ formats incl. image OCR) ships as a regular dependency — zero
//      downloads, zero Python, works offline out of the box; an official
//      MarkItDown CLI is used only when already present on the machine.
//   3. read_document tool (host): paged Markdown reading with a byte-budgeted
//      LRU conversion cache.

import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineReadDocumentTool, ParseCache } from './tool.ts'
import { createUploadHandler, createSweeper } from './upload.ts'
import { probeMarkitdown } from './convert.ts'

const execFileAsync = promisify(execFile)
const execFileAsyncSafe = execFileAsync as (file: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>

/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-file-upload'

/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt', 'webServer', 'sessions', 'credentials']

const MEBIBYTE = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

/** Plugin config, mirroring the schemastery schema below. */
export interface FileUploadConfig {
  uploadMaxBytes: number
  allowedExtensions: string[]
  uploadTtlMs: number
  sweepIntervalMs: number
  maxConcurrentUploads: number
  inlineTextLimit: number
  previewTextLimit: number
  maxFileBytes: number
  readLimit: number
  sheetRowLimit: number
  maxSheets: number
  cacheEntries: number
  cacheMaxBytes: number
  markitdownBin: string
  markitdownTimeoutMs: number
  maxRecordSec: number
  asrEndpoint: string
  asrApiKeyEnv: string
  asrModel: string
  asrMaxBytes: number
  uploadDir: string
}

export const Config = z.object({
  /** Byte cap for one upload body. */
  uploadMaxBytes: z.number().default(24 * MEBIBYTE),
  /** Lowercase extension allowlist; empty means all allowed. */
  allowedExtensions: z.array(z.string()).default([]),
  /** Uploaded files older than this are swept away. */
  uploadTtlMs: z.number().default(7 * DAY_MS),
  /** Sweep interval; 0 disables the periodic sweep. */
  sweepIntervalMs: z.number().default(60 * 60 * 1000),
  /** Concurrent upload bodies admitted at once. */
  maxConcurrentUploads: z.number().default(4),
  /** Byte cap for text inlined straight into the composer. */
  inlineTextLimit: z.number().default(8 * 1024),
  /** Byte cap for the preview returned alongside a large text file. */
  previewTextLimit: z.number().default(2 * 1024),
  /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
  maxFileBytes: z.number().default(24 * MEBIBYTE),
  /** Default and maximum number of lines returned by one read_document call. */
  readLimit: z.number().default(2000),
  /** Rows kept per worksheet. */
  sheetRowLimit: z.number().default(200),
  /** Sheets read per workbook (the rest are reported as truncated). */
  maxSheets: z.number().default(5),
  /** Parse-cache capacity (path + size + mtime fingerprints). */
  cacheEntries: z.number().default(16),
  /** Parse-cache byte budget; large PDFs dominate retained memory. */
  cacheMaxBytes: z.number().default(64 * MEBIBYTE),
  /** Absolute path to a MarkItDown CLI (`markitdown`); empty = auto-detect on PATH. */
  markitdownBin: z.string().default(''),
  /** Timeout for one MarkItDown CLI invocation. */
  markitdownTimeoutMs: z.number().default(120000),
  /** Max voice recording length in seconds (client mic). */
  maxRecordSec: z.number().default(60),
  /** Optional OpenAI-compatible ASR endpoint for audio files; empty disables. */
  asrEndpoint: z.string().default(''),
  /** Env var holding the ASR API key. */
  asrApiKeyEnv: z.string().default('OPENAI_API_KEY'),
  /** ASR model name. */
  asrModel: z.string().default('whisper-1'),
  /** Max audio bytes transcribed inline. */
  asrMaxBytes: z.number().default(25 * MEBIBYTE),
  /** Upload storage root when no sessions service is available. */
  uploadDir: z.string().default(join(process.cwd(), 'uploads'))
})

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-file-upload: ${label} must be a positive integer`)
}

/**
 * Resolve an optional official MarkItDown CLI, in order:
 *   1. explicitly configured `markitdownBin`;
 *   2. a `markitdown` already on PATH.
 * The bundled markitdown-node engine is the always-available backend; the
 * CLI (when present on the machine) simply upgrades conversions further.
 */
async function resolveMarkitdownBin(configured: string): Promise<string> {
  if (configured !== '') return (await probeMarkitdown(configured)) ? configured : ''
  try {
    await execFileAsyncSafe('markitdown', ['--help'], { timeout: 10000 })
    return 'markitdown'
  } catch {
    return ''
  }
}

export function apply(ctx: any, config: FileUploadConfig): void {
  for (const [label, value] of [
    ['uploadMaxBytes', config.uploadMaxBytes],
    ['uploadTtlMs', config.uploadTtlMs],
    ['sweepIntervalMs', config.sweepIntervalMs],
    ['maxConcurrentUploads', config.maxConcurrentUploads],
    ['inlineTextLimit', config.inlineTextLimit],
    ['previewTextLimit', config.previewTextLimit],
    ['maxFileBytes', config.maxFileBytes],
    ['readLimit', config.readLimit],
    ['sheetRowLimit', config.sheetRowLimit],
    ['maxSheets', config.maxSheets],
    ['cacheEntries', config.cacheEntries],
    ['cacheMaxBytes', config.cacheMaxBytes],
    ['markitdownTimeoutMs', config.markitdownTimeoutMs]
  ] as const) {
    assertPositiveInteger(value, label)
  }

  const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes)

  // Shared mutable tool configuration: the MarkItDown probe below writes the
  // resolved binary back here, so read_document picks it up without a restart
  // even when the CLI was found on PATH (auto-detect mode).
  const toolConfig = {
    readLimit: config.readLimit,
    maxFileBytes: config.maxFileBytes,
    sheetRowLimit: config.sheetRowLimit,
    maxSheets: config.maxSheets,
    markitdownBin: config.markitdownBin,
    markitdownTimeoutMs: config.markitdownTimeoutMs
  }

  // MarkItDown probe is async; resolve lazily once at startup. The bundled
  // markitdown-node engine is always available (works out of the box, fully
  // packaged — no downloads, no Python); an official CLI already present on
  // the machine (config or PATH) upgrades conversions further.
  let markitdownReady: Promise<string> | null = null
  const markitdown = () => {
    markitdownReady ??= resolveMarkitdownBin(config.markitdownBin).then((bin) => {
      toolConfig.markitdownBin = bin
      if (bin !== '') {
        console.log(`[dsh-file-upload] MarkItDown CLI detected: ${bin} — official engine takes over conversions`)
      } else {
        console.log(
          '[dsh-file-upload] Document → Markdown ready: bundled MarkItDown engine (20+ formats, image OCR) — fully packaged, no downloads, no Python.'
        )
      }
      return bin
    })
    return markitdownReady
  }

  // Audio transcription, zero-config: an explicit `asrEndpoint` wins; otherwise
  // the standard OpenAI endpoint is used. The API key is resolved **per
  // upload** through the dsh credentials seam (`ctx.credentials.resolve`) —
  // inherited env → $DSH_HOME/.credentials.yaml → project .env — the same
  // convention dsh itself uses, so a key configured in the Models page just
  // works, and a changed key reaches the next upload without a restart.
  const asrEndpoint = config.asrEndpoint !== '' ? config.asrEndpoint : 'https://api.openai.com/v1/audio/transcriptions'
  const asrKeyRef = credentialRef(config.asrApiKeyEnv)
  const resolveAsrKey = async (): Promise<string | undefined> => {
    try {
      const resolved = await ctx.credentials.resolve(asrKeyRef)
      return resolved?.value
    } catch {
      return process.env[config.asrApiKeyEnv]
    }
  }
  console.log(
    `[dsh-file-upload] Audio transcription ready (${asrEndpoint}, model ${config.asrModel}) — key auto-resolved from dsh credentials; voice input works in the browser`
  )

  ctx.systemPrompt.section({
    name: 'tool:read-document',
    order: 110,
    text: 'Files uploaded by the user live under .dsh-uploads/<sessionId>/ inside the workspace. Read them with the read_document tool, which converts PDF/DOCX/XLSX and text files to Markdown and pages through long documents with offset and limit. Prefer read_document over read for these files. For uploaded image files: if the official read_image tool is available (current model supports image input), use it to see the image directly; otherwise call read_document on the image path, which returns an OCR text description via the bundled engine.'
  })

  // Detect whether a session's routed model accepts image input, so the
  // agent is told to use the official read_image tool (native) or OCR
  // (read_document). Mirrors the official read_image route gate.
  const resolveImageMode = async (sessionId: string): Promise<'native' | 'ocr'> => {
    try {
      const llm = ctx.get('llm')
      if (llm === undefined) return 'ocr'
      const session = ctx.sessions.get(sessionId)
      const header = session?.requestHeader?.() ?? undefined
      const provider = header?.config?.provider
      const model = header?.config?.model
      if (provider === undefined || model === undefined) return 'ocr'
      const info = await llm.resolveModelInfo(provider, model)
      return info.inputModalities?.includes('image') === true ? 'native' : 'ocr'
    } catch {
      return 'ocr'
    }
  }

  ctx.tools.register(defineReadDocumentTool(ctx, toolConfig, cache))
  const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads')
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/upload',
      handler: createUploadHandler({
        maxBytes: config.uploadMaxBytes,
        allowedExtensions: config.allowedExtensions,
        ttlMs: config.uploadTtlMs,
        sweepIntervalMs: config.sweepIntervalMs,
        maxConcurrent: config.maxConcurrentUploads,
        inlineTextLimit: config.inlineTextLimit,
        previewTextLimit: config.previewTextLimit,
        defaultDir,
        asr: {
          endpoint: asrEndpoint,
          apiKey: '',
          model: config.asrModel,
          timeoutMs: 60000
        },
        asrKey: resolveAsrKey,
        asrMaxBytes: config.asrMaxBytes,
        imageMode: resolveImageMode,
        sessionCwd: (sessionId: string) => {
          const session = ctx.sessions.get(sessionId)
          return session === undefined ? undefined : session.header.cwd
        }
      })
    })
  )

  // Sweep every upload root: the fallback dir plus each live session's
  // workspace `.dsh-uploads` (session cwds resolved per sweep, so files under
  // session workspaces age out too — not just the no-session fallback root).
  const disposeSweeper = createSweeper(
    [
      defaultDir,
      () => {
        // All live sessions, in creation order (official SessionStore.list).
        for (const session of ctx.sessions.list()) {
          const cwd = session.header?.cwd
          if (cwd !== undefined) return cwd
        }
        return undefined
      }
    ],
    config.uploadTtlMs,
    config.sweepIntervalMs
  )
  ctx.on('dispose', disposeSweeper)

  // Kick the MarkItDown probe in the background so the first read_document
  // call does not pay the probe latency.
  void markitdown()
}
