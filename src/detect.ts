/** Shared vocabulary for dsh-file-upload. @module dsh-file-upload/types */

/** Categories the sniffing chain can assign to an uploaded file. */
export type SniffedType =
  | 'text'      // UTF-8/UTF-16/GB18030 text: code, json, csv, log, config, markdown…
  | 'pdf'       // Portable Document Format
  | 'docx'      // Office Open XML wordprocessing
  | 'xlsx'      // Office Open XML spreadsheet
  | 'image'     // raster image (png/jpeg/webp/gif)
  | 'audio'     // audio container (wav/mp3/m4a/flac/ogg/webm…)
  | 'archive'   // zip container (docx/xlsx are checked first)
  | 'binary'    // anything else: handed to the agent as path + sha256

/** Marker categories for archive containers. */
export type ArchiveKind = 'zip' | 'other'

/** Result of the content sniff. */
export interface SniffResult {
  /** Assigned category; `binary` means "agent handles by path". */
  type: SniffedType
  /** Lowercase extension when present. */
  ext: string
  /** Human label for UI badges. */
  label: string
  /** Whether the bytes look like a text encoding we can decode. */
  likelyText: boolean
  /** Detected encoding for text (`utf8` | `utf16le` | `gb18030`). */
  encoding?: 'utf8' | 'utf16le' | 'gb18030'
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'cfg', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'fish', 'ps1', 'bat', 'sql', 'graphql', 'proto', 'dockerfile', 'gitignore',
  'env', 'properties', 'lock', 'sum', 'sha256', 'diff', 'patch', 'vue', 'svelte'
])

const PDF_HEAD = /^%PDF-/
const ZIP_HEAD = /^PK\x03\x04/
const DOCX_HEAD = /^PK\x03\x04/ // differentiated by [Content_Types].xml below
const XLSX_HEAD = /^PK\x03\x04/

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

/**
 * Decide whether bytes are decodable text and which encoding they use.
 * Mirrors the official read tool's chain: UTF-16 BOM → UTF-8 (fatal) → GB18030.
 */
export function detectEncoding(data: Buffer): { likelyText: boolean; encoding?: 'utf8' | 'utf16le' | 'gb18030' } {
  if (data.length === 0) return { likelyText: true, encoding: 'utf8' }
  if (data.subarray(0, 2).equals(UTF16LE_BOM)) return { likelyText: true, encoding: 'utf16le' }
  if (data.subarray(0, 2).equals(UTF16BE_BOM)) return { likelyText: true, encoding: 'utf16le' }
  // UTF-8 fatal: reject on invalid sequences.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return { likelyText: true, encoding: 'utf8' }
  } catch {
    // fall through
  }
  // GB18030 is a superset of GBK; nearly every byte sequence decodes, so gate
  // on a heuristic: reject when the sample is dominated by C0 control chars
  // other than common whitespace.
  const sample = data.subarray(0, Math.min(data.length, 4096))
  let controls = 0
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1
  }
  if (controls / sample.length < 0.05) {
    return { likelyText: true, encoding: 'gb18030' }
  }
  return { likelyText: false }
}

/** Null bytes in the first 8 KiB almost certainly mean binary content. */
function hasNulBytes(data: Buffer): boolean {
  const sample = data.subarray(0, Math.min(data.length, 8192))
  return sample.includes(0)
}

/** Sniff the first bytes of an uploaded file. Never trusts the extension. */
export function sniff(data: Buffer, fileName: string): SniffResult {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''

  const head = data.subarray(0, 512)

  if (PDF_HEAD.test(head.toString('latin1'))) {
    return { type: 'pdf', ext, label: 'PDF', likelyText: false }
  }

  if (ZIP_HEAD.test(head.toString('latin1'))) {
    // Distinguish OOXML by the presence of [Content_Types].xml in the central directory.
    const name = data.subarray(0, Math.min(data.length, 65536)).toString('latin1')
    if (name.includes('[Content_Types].xml') && name.includes('word/')) {
      return { type: 'docx', ext, label: 'DOCX', likelyText: false }
    }
    if (name.includes('[Content_Types].xml') && name.includes('xl/')) {
      return { type: 'xlsx', ext, label: 'XLSX', likelyText: false }
    }
    return { type: 'archive', ext, label: 'ZIP', likelyText: false }
  }

  const image = /^\x89PNG\r\n\x1a\n|^\xFF\xD8\xFF|^RIFF....WEBP|^GIF87a|^GIF89a/
  if (image.test(head.toString('latin1'))) {
    return { type: 'image', ext, label: ext.toUpperCase(), likelyText: false }
  }

  // Audio containers: WAV (RIFF....WAVE), MP3 (ID3 or 0xFF sync frames),
  // M4A/MP4 (ftyp — gated on a media extension so plain text cannot match),
  // FLAC (fLaC), OGG (OggS), WebM/Matroska (1A45DFA3).
  const AUDIO_EXTS = new Set(['wav', 'mp3', 'm4a', 'mp4', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mka', 'aiff'])
  const audio = /^RIFF....WAVE|^ID3|^\xFF\xFB|^\xFF\xF3|^\xFF\xF2|^fLaC|^OggS|^\x1A\x45\xDF\xA3|^[\x00-\x7f]{4}ftyp/
  if (audio.test(head.toString('latin1'))) {
    if (!/^[\x00-\x7f]{4}ftyp/.test(head.toString('latin1')) || AUDIO_EXTS.has(ext)) {
      return { type: 'audio', ext, label: ext === '' ? 'AUDIO' : ext.toUpperCase(), likelyText: false }
    }
  }

  // UTF-16 text legitimately contains NUL bytes; honor its BOM before the
  // binary heuristic rejects it.
  if (data.subarray(0, 2).equals(UTF16LE_BOM) || data.subarray(0, 2).equals(UTF16BE_BOM)) {
    return {
      type: 'text',
      ext,
      label: ext === '' ? 'TXT' : ext.toUpperCase(),
      likelyText: true,
      encoding: 'utf16le'
    }
  }

  if (hasNulBytes(data)) {
    return { type: 'binary', ext, label: ext === '' ? 'BIN' : ext.toUpperCase(), likelyText: false }
  }

  const text = detectEncoding(data)
  if (text.likelyText) {
    return {
      type: 'text',
      ext,
      label: ext === '' ? 'TXT' : ext.toUpperCase(),
      likelyText: true,
      encoding: text.encoding
    }
  }

  return { type: 'binary', ext, label: ext === '' ? 'BIN' : ext.toUpperCase(), likelyText: false }
}
