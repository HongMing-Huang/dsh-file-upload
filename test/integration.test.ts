import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertMarkitdown, probeMarkitdown, convertJs, convertMarkitdownNode, convertDocument } from '../src/convert.ts'
import { sniff } from '../src/detect.ts'

const execFileAsync = promisify(execFile) as (file: string, args: string[], opts: object) => Promise<{ stdout: string; stderr: string }>

/** Locate a usable markitdown CLI: env var, venv inside the repo, or PATH. */
function findMarkitdown(): string {
  if (process.env.MARKITDOWN_BIN !== undefined && process.env.MARKITDOWN_BIN !== '') return process.env.MARKITDOWN_BIN
  const candidates = [
    join(process.cwd(), '.venv', 'bin', 'markitdown'),
    join(process.cwd(), '.venv', 'Scripts', 'markitdown.exe')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'markitdown'
}

const bin = findMarkitdown()

test('probeMarkitdown: detects the CLI', { skip: !existsSync(bin) && process.env.MARKITDOWN_BIN === undefined && bin === 'markitdown' }, async () => {
  const ok = await probeMarkitdown(bin)
  assert.equal(ok, true)
})

test('convertMarkitdown: converts a markdown file', { skip: !existsSync(bin) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-'))
  const file = join(dir, 'sample.md')
  writeFileSync(file, '# Hello\n\n- a\n- b\n')
  const result = await convertMarkitdown(bin, file, 60000)
  assert.match(result.markdown, /# Hello/)
  assert.match(result.markdown, /- a/)
  assert.equal(result.backend, 'markitdown-cli')
})

test('convertMarkitdownNode: bundled engine converts DOCX out of the box', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-'))
  const docx = join(dir, 'sample.docx')
  const html = join(dir, 'sample.html')
  writeFileSync(html, '<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>')
  const { spawnSync } = await import('node:child_process')
  const conv = spawnSync('textutil', ['-convert', 'docx', html, '-output', docx], { encoding: 'utf8' })
  if (conv.status !== 0 || !existsSync(docx)) return // skip when no docx generator
  const result = await convertMarkitdownNode(docx)
  assert.equal(result.backend, 'markitdown-node')
  assert.match(result.markdown, /Title/i)
})

test('convertDocument: text fast-path bypasses engines', async () => {
  const data = Buffer.from('plain text here\n', 'utf8')
  const r = sniff(data, 'x.txt')
  const result = await convertDocument('/tmp/whatever.txt', data, r, {
    maxFileBytes: 1 << 20,
    sheetRowLimit: 100,
    maxSheets: 3
  })
  assert.equal(result.backend, 'js')
  assert.equal(result.markdown, 'plain text here\n')
})

test('convertMarkitdown: converts a DOCX via markitdown extras', { skip: !existsSync(bin) }, async () => {
  // Generate a minimal DOCX using the zip container + word/document.xml skeleton.
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-'))
  const docx = join(dir, 'sample.docx')
  const { execFileSync } = await import('node:child_process')
  const { spawnSync } = await import('node:child_process')
  // Use textutil on macOS to produce a real DOCX from HTML.
  const html = join(dir, 'sample.html')
  writeFileSync(html, '<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>')
  const conv = spawnSync('textutil', ['-convert', 'docx', html, '-output', docx], { encoding: 'utf8' })
  if (conv.status !== 0 || !existsSync(docx)) {
    // Non-macOS: try pandoc if present.
    const pd = spawnSync('pandoc', [html, '-o', docx], { encoding: 'utf8' })
    if (pd.status !== 0 || !existsSync(docx)) return // skip silently when no generator
  }
  const result = await convertMarkitdown(bin, docx, 60000)
  assert.match(result.markdown, /Title/)
})

test('convertJs: text passthrough matches sniffed encoding', () => {
  const data = Buffer.from('const a = 1\n', 'utf8')
  const r = sniff(data, 'x.js')
  return convertJs(data, r, { maxFileBytes: 1 << 20, sheetRowLimit: 100, maxSheets: 3 }).then((out) => {
    assert.equal(out.backend, 'js')
    assert.equal(out.markdown, 'const a = 1\n')
  })
})

test('convertJs: rejects unsupported types (binary)', async () => {
  const data = Buffer.from([0x00, 0x01, 0x02, 0xff])
  const r = sniff(data, 'x.bin')
  await assert.rejects(() => convertJs(data, r, { maxFileBytes: 1 << 20, sheetRowLimit: 100, maxSheets: 3 }))
})
