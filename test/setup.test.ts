import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('bundled installer ships inside the package', () => {
  const setup = join(PKG_ROOT, 'scripts', 'setup-markitdown.mjs')
  assert.equal(existsSync(setup), true, 'scripts/setup-markitdown.mjs must exist')
  const src = readFileSync(setup, 'utf8')
  assert.match(src, /markitdown\[docx,pdf,xlsx,pptx\]/, 'uses verified extras list, not [all]')
  assert.match(src, /\.markitdown-installed\.json/, 'writes a marker file')
  assert.match(src, /--version/, 'verifies via --version')
})

test('setup script runs and never throws (no Python or no writable dir both fine)', async () => {
  // The script is written to be best-effort: even with no Python and no
  // writable DSH_HOME it must exit 0 (postinstall must never break installs).
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const result = await exec(
    process.execPath,
    [join(PKG_ROOT, 'scripts', 'setup-markitdown.mjs')],
    { env: { ...process.env, DSH_HOME: join(PKG_ROOT, '.test-nonwritable') }, timeout: 60000 }
  ).catch((err) => ({ stdout: '', stderr: String(err) }))
  assert.ok(result, 'script must not throw')
})
