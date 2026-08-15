/** read_document tool: page through uploaded documents with on-demand
 * conversion to Markdown (text fast-path, optional MarkItDown CLI, bundled
 * markitdown-node engine, JS fallback). Reads through ctx.fs, so workspace
 * resolution, sandbox policy and fs-observation policy behave exactly like
 * the built-in read tool. Results are cached with a byte-budgeted LRU keyed
 * by (targetKey, version, format), so re-reads after an edit re-parse while
 * identical files hit the cache.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { sniff } from './detect.ts'
import { convertDocument } from './convert.ts'
import type { ConvertOptions } from './convert.ts'

export interface ReadDocumentConfig {
  readLimit: number
  maxFileBytes: number
  sheetRowLimit: number
  maxSheets: number
  markitdownBin?: string
  markitdownTimeoutMs?: number
}

export interface CacheEntry {
  markdown: string
  bytes: number
}

/** Byte-budgeted LRU cache keyed by targetKey+version+format. */
export class ParseCache {
  private readonly entries = new Map<string, CacheEntry>()
  private totalBytes = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    // touch for LRU
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.markdown
  }

  set(key: string, markdown: string): void {
    const bytes = markdown.length
    const existing = this.entries.get(key)
    if (existing !== undefined) this.totalBytes -= existing.bytes
    this.entries.delete(key)
    this.entries.set(key, { markdown, bytes })
    this.totalBytes += bytes
    while ((this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string
      const entry = this.entries.get(oldest)
      if (entry !== undefined) this.totalBytes -= entry.bytes
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

interface ParsedArgs {
  filePath: string
  offset: number
  limit: number
}

function parseArgs(args: Record<string, unknown>, config: ReadDocumentConfig): ParsedArgs {
  if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }
  const offset = typeof args.offset === 'number' ? args.offset : 1
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
  const limit = typeof args.limit === 'number' ? args.limit : config.readLimit
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  if (limit > config.readLimit) throw new Error(`limit must be less than or equal to ${config.readLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/** The session workspace cwd for this call, when one applies. */
function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}

function renderEnvelope(path: string, value: { offset: number; lines: Array<{ number: number; text: string }>; totalLines: number }): string {
  // Envelope with a two-line body preview: the model sees at a glance that the
  // content lives in `lines`, not just metadata.
  const preview = value.lines
    .slice(0, 2)
    .map((l) => `  ${l.number}: ${l.text.slice(0, 120)}`)
    .join('\n')
  return [
    `### document ${path}`,
    `offset ${value.offset}, ${value.lines.length}/${value.totalLines} lines; full content in \`lines\`:`,
    preview
  ].join('\n')
}

export function defineReadDocumentTool(ctx: {
  fs: {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
    stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion; type: string; size?: number } | undefined>
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  }
  emit(event: string, target: FsTarget, observation: object, exec: object): void
}, config: ReadDocumentConfig, cache: ParseCache) {
  const convertOptions: ConvertOptions = {
    maxFileBytes: config.maxFileBytes,
    sheetRowLimit: config.sheetRowLimit,
    maxSheets: config.maxSheets,
    markitdownBin: config.markitdownBin,
    markitdownTimeoutMs: config.markitdownTimeoutMs
  }

  return defineTool({
    name: 'read_document',
    description:
      'Read an uploaded document (PDF, DOCX, XLSX) or text file and return its content as line-numbered pages converted to Markdown. Use for uploaded files under .dsh-uploads/ that the plain read tool cannot handle, and page through long documents with offset and limit.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the uploaded file, resolved by the filesystem backend.'
      },
      offset: {
        type: 'number',
        description: '1-based first line to return. Defaults to 1.'
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return. Defaults to ${config.readLimit}.`
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true }
              }
            }
          },
          totalLines: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderEnvelope(value.path, value)
        }
      ]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseArgs(args, config)
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (info.size !== undefined && info.size > config.maxFileBytes) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        throw new FsError(
          `cannot read "${target.displayPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`,
          'FS_TOO_LARGE'
        )
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes)
      const sniffResult = sniff(Buffer.from(bytes), target.displayPath)

      const cacheKey = `${target.targetKey}:${JSON.stringify(info.version)}:${sniffResult.type}`
      let markdown = cache.get(cacheKey)
      if (markdown === undefined) {
        // Unified chain: text fast-path → MarkItDown CLI (when enabled) →
        // bundled markitdown-node engine (PDF/DOCX/XLSX/PPTX/HTML/CSV/…,
        // images via OCR) → lightweight JS parsers.
        const result = await convertDocument(target.displayPath, Buffer.from(bytes), sniffResult, convertOptions)
        markdown = result.markdown
        cache.set(cacheKey, markdown)
      }

      const allLines = markdown.split('\n')
      const slice = allLines.slice(input.offset - 1, input.offset - 1 + input.limit)
      const lines = slice.map((text, i) => ({ number: input.offset + i, text }))
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: target.displayPath,
        offset: input.offset,
        lines,
        totalLines: allLines.length
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read document ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }]
      }
    }
  })
}
