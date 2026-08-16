import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sniff, detectEncoding } from '../src/detect.ts'

test('sniff: plain UTF-8 text', () => {
  const data = Buffer.from('hello world\nline two\n', 'utf8')
  const r = sniff(data, 'notes.txt')
  assert.equal(r.type, 'text')
  assert.equal(r.likelyText, true)
  assert.equal(r.encoding, 'utf8')
})

test('sniff: code file with no extension', () => {
  const data = Buffer.from('const x = 1\nexport default x\n', 'utf8')
  const r = sniff(data, 'index')
  assert.equal(r.type, 'text')
  assert.equal(r.label, 'TXT')
})

test('sniff: JSON content', () => {
  const data = Buffer.from('{"a": 1, "b": [1,2,3]}', 'utf8')
  const r = sniff(data, 'data.json')
  assert.equal(r.type, 'text')
})

test('sniff: PDF magic header wins over extension trick', () => {
  const data = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0)])
  const r = sniff(data, 'evil.txt')
  assert.equal(r.type, 'pdf')
})

test('sniff: ZIP container', () => {
  const data = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 0)])
  const r = sniff(data, 'bundle.zip')
  assert.equal(r.type, 'archive')
})

test('sniff: binary with NUL bytes', () => {
  const data = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(256, 0)])
  const r = sniff(data, 'tool.exe')
  assert.equal(r.type, 'binary')
})

test('sniff: PNG image', () => {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A — bytes, not a UTF-8 string.
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)])
  const r = sniff(data, 'shot.png')
  assert.equal(r.type, 'image')
})

test('sniff: WAV audio', () => {
  const data = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(16, 0)])
  const r = sniff(data, 'voice.wav')
  assert.equal(r.type, 'audio')
})

test('sniff: MP3 audio (ID3 tag)', () => {
  const data = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10, 0)])
  const r = sniff(data, 'song.mp3')
  assert.equal(r.type, 'audio')
})

test('sniff: FLAC audio', () => {
  const data = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16, 0)])
  const r = sniff(data, 'song.flac')
  assert.equal(r.type, 'audio')
})

test('sniff: text file starting with ftyp-like bytes is NOT audio', () => {
  // "1234ftyp" would match a naive ftyp regex; with no media extension it
  // must fall through to text detection.
  const data = Buffer.from('1234ftyp-this-is-plain-text-content', 'utf8')
  const r = sniff(data, 'notes.txt')
  assert.equal(r.type, 'text')
})

test('sniff: M4A with ftyp header and media extension', () => {
  const data = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(16, 0)])
  const r = sniff(data, 'song.m4a')
  assert.equal(r.type, 'audio')
})

test('sniff: UTF-16 LE BOM detection', () => {
  const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])
  const r = sniff(data, 'doc.txt')
  assert.equal(r.type, 'text')
  assert.equal(r.encoding, 'utf16le')
})

test('detectEncoding: GB18030 bytes are accepted as text', () => {
  // "中文" in GB18030
  const data = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  const r = detectEncoding(data)
  assert.equal(r.likelyText, true)
  assert.equal(r.encoding, 'gb18030')
})

test('detectEncoding: random binary is not text', () => {
  const data = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xfe, 0xfd])
  const r = detectEncoding(data)
  assert.equal(r.likelyText, false)
})
