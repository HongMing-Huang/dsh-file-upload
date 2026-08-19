import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeText } from '../src/convert.ts'
import { sanitizeFileName, sanitizeSessionId } from '../src/upload.ts'

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

