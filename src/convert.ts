/** Document → Markdown conversion chain.
 *
 * Three backends, most-capable first:
 *   - Microsoft MarkItDown CLI (`markitdown <file>`) — when `markitdownBin`
 *     is configured (or auto-detected on PATH) it wins: clean Markdown,
 *     audio transcription via Whisper, EPUB, Bing SERP and more;
 *   - built-in `markitdown-node` engine — a TypeScript port of MarkItDown
 *     bundled as a regular dependency, so document → Markdown works out of
 *     the box with zero external tooling (PDF, DOCX, PPTX, XLSX, HTML, CSV,
 *     JSON, XML, ZIP, Jupyter, images with OCR, …);
 *   - fast-path JS parsers for plain text (matching the official `read`
 *     tool's decoding chain) and a lightweight fallback for PDF/DOCX/XLSX.
 *
 * The chain never trusts the file extension: every parser re-verifies the
 * sniffed category before reading bytes.
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { SniffResult } from './detect.ts'

const execFileAsync = promisify(execFile)

export interface ConvertOptions {
  /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
  maxFileBytes: number
  /** Rows kept per worksheet. */
  sheetRowLimit: number
  /** Sheets read per workbook (the rest are reported as truncated). */
  maxSheets: number
  /** Absolute path to the `markitdown` CLI; empty disables the external backend. */
  markitdownBin?: string
  /** CLI timeout in milliseconds. */
  markitdownTimeoutMs?: number
}

export interface ConvertResult {
  /** Markdown text extracted from the document. */
  markdown: string
  /** True when the extraction had to cut content (paging / limits). */
  truncated: boolean
  /** Which backend produced the result. */
  backend: 'js' | 'markitdown-node' | 'markitdown-cli'
  /** Optional human note (e.g. truncated sheets). */
  note?: string
}

const execFileAsyncSafe = execFileAsync as (file: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>

/** Detect whether the markitdown CLI is runnable at the given path. */
export async function probeMarkitdown(bin: string): Promise<boolean> {
  if (bin === '') return false
  try {
    await execFileAsyncSafe(bin, ['--help'], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

/** Decode bytes as text using the sniffed encoding. */
export function decodeText(data: Buffer, encoding: 'utf8' | 'utf16le' | 'gb18030' | undefined): string {
  if (encoding === 'utf16le') return data.toString('utf16le')
  if (encoding === 'gb18030') {
    try {
      // Node ships no GB18030 decoder; the official chain treats this as a
      // lossy best-effort path via TextDecoder when the runtime provides it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decoder = new (TextDecoder as any)('gb18030')
      return decoder.decode(data)
    } catch {
      return data.toString('latin1')
    }
  }
  return data.toString('utf8')
}

/** Extract text from a PDF using pdfjs-dist (Mozilla's PDF.js, legacy build). */
async function extractPdf(data: Buffer, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({
    data: new Uint8Array(data),
    // Node has no web worker; these options keep the legacy build self-contained.
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true
  } as Parameters<typeof getDocument>[0] & {
    disableWorker: boolean
    isEvalSupported: boolean
    useSystemFonts: boolean
  }).promise
  try {
    const pages: string[] = []
    let total = 0
    const pageCount = doc.numPages
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        const lines: string[] = []
        let line = ''
        for (const item of content.items) {
          if ('str' in item) {
            line += item.str
            if (item.hasEOL) {
              lines.push(line)
              line = ''
            }
          }
        }
        if (line !== '') lines.push(line)
        const text = lines.join('\n')
        pages.push(`<!-- page ${i}/${pageCount} -->\n\n${text}`)
        total += text.length
        if (total > maxBytes) break
      } finally {
        page.cleanup()
      }
    }
    return { text: pages.join('\n\n'), truncated: total > maxBytes || pages.length < pageCount }
  } finally {
    await doc.destroy()
  }
}

/** Extract text from a DOCX using mammoth. */
async function extractDocx(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: data })
  return { text: result.value.trim(), truncated: result.messages.length > 0 }
}

/** Extract cells from an XLSX using read-excel-file (node entry, read-only). */
async function extractXlsx(data: Buffer, sheetRowLimit: number, maxSheets: number): Promise<{ text: string; truncated: boolean }> {
  const { default: readXlsxFile, readSheetNames } = await import('read-excel-file/node')
  const buf = Buffer.from(data)
  const sheetNames = await readSheetNames(buf)
  const sheets = sheetNames.length > 0 ? sheetNames.slice(0, maxSheets) : [1]

  const parts: string[] = []
  let totalRows = 0
  let truncated = false
  let sheetTruncated = false

  for (const sheet of sheets) {
    const rows = await readXlsxFile(buf, { sheet })
    totalRows += rows.length
    const kept = rows.slice(0, sheetRowLimit)
    if (rows.length > kept.length) sheetTruncated = true
    parts.push(`### Sheet: ${String(sheet)}\n${rowsToText(kept)}`)
  }

  if (sheetNames.length > sheets.length) {
    parts.push(`… 另有 ${sheetNames.length - sheets.length} 个 sheet 未读取（上限 ${maxSheets}）`)
    truncated = true
  }
  if (sheetTruncated) {
    parts.push(`… 已截断：每个 sheet 仅保留前 ${sheetRowLimit} 行，全簿共 ${totalRows} 行`)
  }

  return { text: parts.join('\n\n'), truncated }
}

function rowsToText(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          if (value === null || value === undefined) return ''
          if (value instanceof Date) return value.toISOString().slice(0, 10)
          return String(value)
        })
        .join('\t')
        .replace(/\s+$/, '')
    )
    .join('\n')
}

/** Convert document bytes to Markdown with the built-in JS parsers. */
export async function convertJs(data: Buffer, sniff: SniffResult, options: ConvertOptions): Promise<ConvertResult> {
  switch (sniff.type) {
    case 'text': {
      const text = decodeText(data, sniff.encoding)
      return { markdown: text, truncated: false, backend: 'js' }
    }
    case 'pdf': {
      const { text, truncated } = await extractPdf(data, options.maxFileBytes)
      return { markdown: text, truncated, backend: 'js' }
    }
    case 'docx': {
      const { text, truncated } = await extractDocx(data)
      return { markdown: text, truncated, backend: 'js' }
    }
    case 'xlsx': {
      const { text, truncated } = await extractXlsx(data, options.sheetRowLimit, options.maxSheets)
      return { markdown: text, truncated, backend: 'js', note: truncated ? 'truncated' : undefined }
    }
    default:
      throw new Error(`convertJs: unsupported sniffed type "${sniff.type}"`)
  }
}

/**
 * Convert a document on disk to Markdown with the bundled `markitdown-node`
 * engine (a TypeScript MarkItDown port covering PDF/DOCX/PPTX/XLSX/HTML/CSV/
 * JSON/XML/ZIP/Jupyter/images-OCR/…). Works out of the box — no Python, no
 * external tools. Text-like files are handled by the fast JS path instead.
 */
export async function convertMarkitdownNode(filePath: string): Promise<ConvertResult> {
  const require = createRequire(import.meta.url)
  // markitdown-node ships CJS; createRequire avoids ESM/CJS ambiguity errors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { MarkItDown } = require('markitdown-node') as { MarkItDown: new () => any }
  const md = new MarkItDown()
  const result = await md.convert(filePath)
  if (result.status !== 'success') {
    const detail = Array.isArray(result.errors) ? result.errors.join('; ') : String(result.errors ?? 'unknown error')
    throw new Error(`markitdown-node: ${detail}`)
  }
  // content is an array of typed items ({type, text, formatting}).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: Array<{ type?: string; text?: unknown; children?: unknown }> = result.document?.content ?? []
  const lines = items.map((item) => {
    const text = extractItemText(item)
    if (item.type === 'heading') return `## ${text}`
    if (item.type === 'listItem' || item.type === 'list-item') return `- ${text}`
    return text
  })
  return { markdown: lines.filter((l) => l !== '').join('\n'), truncated: false, backend: 'markitdown-node' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractItemText(item: any): string {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item
  if (Array.isArray(item)) return item.map(extractItemText).join(' ')
  if (typeof item === 'object') {
    const text = item.text ?? item.content ?? item.value ?? item.children
    if (Array.isArray(text) || (typeof text === 'object' && text !== null)) return extractItemText(text)
    return text === null || text === undefined ? '' : String(text)
  }
  return String(item)
}

/**
 * Unified conversion entry: plain text takes the fast decode path; documents
 * use the Microsoft MarkItDown CLI when available, otherwise the bundled
 * markitdown-node engine, falling back to the lightweight JS parsers.
 */
export async function convertDocument(
  filePath: string,
  data: Buffer,
  sniff: SniffResult,
  options: ConvertOptions
): Promise<ConvertResult> {
  if (sniff.type === 'text') {
    return { markdown: decodeText(data, sniff.encoding), truncated: false, backend: 'js' }
  }
  if (options.markitdownBin !== undefined && options.markitdownBin !== '') {
    try {
      return await convertMarkitdown(options.markitdownBin, filePath, options.markitdownTimeoutMs ?? 120000)
    } catch (err) {
      console.warn(`[dsh-file-upload] MarkItDown CLI failed for ${filePath}, falling back to bundled engine:`, err)
    }
  }
  try {
    return await convertMarkitdownNode(filePath)
  } catch (err) {
    console.warn(`[dsh-file-upload] bundled engine failed for ${filePath}, falling back to JS parsers:`, err)
  }
  return convertJs(data, sniff, options)
}

/**
 * Convert document bytes to Markdown via the Microsoft MarkItDown CLI.
 * The CLI accepts the file on disk and prints Markdown to stdout.
 */
export async function convertMarkitdown(bin: string, filePath: string, timeoutMs: number): Promise<ConvertResult> {
  const { stdout } = await execFileAsyncSafe(bin, [filePath], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  return { markdown: stdout.trim(), truncated: false, backend: 'markitdown-cli' }
}
