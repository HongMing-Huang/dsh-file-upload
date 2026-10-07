import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zh, en } from '../src/client/locale.ts'
import { UPLOAD_ERROR_CODES } from '../src/upload.ts'

// The `en` annotation makes key drift a compile error, but only for code that
// imports the type; these tests keep the same invariant true at runtime, where
// the registry actually reads the dictionaries.

test('locale: en covers every zh key, and no others', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('locale: both dictionaries carry the same placeholders', () => {
  const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `placeholder mismatch for ${key}`)
  }
})

test('locale: every upload error code has a dictionary entry', () => {
  // The server answers a `code`; the client renders `error.<code>`. Nothing
  // else couples those two lists, so the coupling is asserted here.
  for (const code of UPLOAD_ERROR_CODES) {
    const key = `error.${code}`
    assert.ok(key in zh, `zh is missing ${key}`)
    assert.ok(key in en, `en is missing ${key}`)
  }
})