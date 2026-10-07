import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zh, en } from '../src/client/locale.ts'

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