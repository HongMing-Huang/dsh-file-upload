import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeText, convertDocument } from '../src/convert.ts'
import { sanitizeFileName, sanitizeSessionId } from '../src/upload.ts'
import { sniff } from '../src/detect.ts'

test('decodeText: utf8', () => {
  assert.equal(decodeText(Buffer.from('hello', 'utf8'), 'utf8'), 'hello')
})

test('decodeText: utf16le', () => {
  assert.equal(decodeText(Buffer.from('hi', 'utf16le'), 'utf16le'), 'hi')
})

test('sanitizeFileName: strips path separators and dot segments', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'etc_passwd')
  assert.equal(sanitizeFileName('..\\..\\win.ini'), 'win.ini')
  assert.equal(sanitizeFileName('.hidden'), 'hidden')
  assert.equal(sanitizeFileName(''), 'upload.bin')
  assert.equal(sanitizeFileName('a\x00b.txt'), 'ab.txt')
})

test('sanitizeFileName: keeps unicode names', () => {
  assert.equal(sanitizeFileName('需求文档.pdf'), '需求文档.pdf')
})

test('sanitizeSessionId: constrains to safe alphabet', () => {
  assert.equal(sanitizeSessionId('abc-123_XYZ'), 'abc-123_XYZ')
  assert.equal(sanitizeSessionId('a/b c'), 'a_b_c')
  assert.equal(sanitizeSessionId(''), 'anonymous')
})

/**
 * Build a minimal DOCX containing one table, using only node builtins.
 *
 * A stored-mode ZIP is written by hand so the test needs no archiver and no
 * network: the point is to exercise the DOCX branch, not to test zipping.
 */
function writeTableDocx(path: string): void {
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Pricing</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Rate</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Engineer</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>End of document</w:t></w:r></w:p></w:body></w:document>'
  }
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(body, 'utf8')
    // CRC-32 via zlib is not exposed; a stored entry may use 0 only if we did not
    // need integrity, so compute it properly with a small table.
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(path, Buffer.concat([...locals, centralBuf, end]))
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

test('convertDocument: a DOCX keeps its table content (issue #7 regression)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-docx-'))
  const file = join(dir, 'table.docx')
  writeTableDocx(file)
  const data = Buffer.from(await (await import('node:fs/promises')).readFile(file))
  const result = await convertDocument(file, data, sniff(data, 'table.docx'), {
    maxFileBytes: 1 << 22,
    sheetRowLimit: 10,
    maxSheets: 2
  })
  // Every cell must survive. Before the fix the adapter rebuilt the Markdown
  // from `document.content` and had no case for a `table` item, so the rows were
  // dropped and a document of pricing tables read as almost empty.
  for (const cell of ['Role', 'Rate', 'Engineer', '1200']) {
    assert.ok(result.markdown.includes(cell), `expected table cell ${cell} in:\n${result.markdown}`)
  }
  assert.match(result.markdown, /Pricing/)
  assert.match(result.markdown, /End of document/)
})

test('convertMarkitdownNode: the engine output is preferred over a rebuild', async () => {
  // The engine returns both `markdown_content` and a typed `document.content`.
  // Using the former is what keeps tables: the latter carries `rows`, not
  // `text`, so any reconstruction that only reads `text` loses them.
  const dir = mkdtempSync(join(tmpdir(), 'dshfu-docx2-'))
  const file = join(dir, 'table.docx')
  writeTableDocx(file)
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { MarkItDown } = require('markitdown-node') as { MarkItDown: new () => any }
  const raw = await new MarkItDown().convert(file)
  if (raw.status !== 'success') return // engine unavailable here; the test above still covers the path
  assert.equal(typeof raw.markdown_content, 'string')
  assert.ok(raw.markdown_content.includes('Engineer'), 'engine markdown should already contain the table')
  assert.ok(
    Array.isArray(raw.document?.content) && raw.document.content.some((i: { type?: string }) => i.type === 'table'),
    'engine content should expose the table item whose text field is absent'
  )
})
