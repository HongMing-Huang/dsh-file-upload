#!/usr/bin/env node
// setup-markitdown.mjs — best-effort installer for the official Microsoft
// MarkItDown CLI, bundled with dsh-file-upload.
//
// What it does:
//   1. finds a usable Python (>= 3.10) on the machine;
//   2. creates an isolated venv under $DSH_HOME/markitdown (fallback:
//      ~/.dsh/markitdown, then the package directory);
//   3. pip-installs `markitdown[docx,pdf,xlsx,pptx]` into that venv;
//   4. writes a marker file recording the resulting CLI path.
//
// Design rules:
//   - NEVER fails the package install: every error is caught and downgraded
//     to a warning (the bundled markitdown-node engine keeps working).
//   - Runs once; the marker file skips repeated installs.
//   - Explicit extras list instead of `[all]`: on Python 3.14 `[all]` can
//     resolve to the ancient 0.0.2 release (verified 2026-08).
//   - The plugin's apply() reads the marker at startup, so the CLI becomes
//     available on the next boot without user configuration.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MARKER_NAME = '.markitdown-installed.json'
const EXTRAS = 'markitdown[docx,pdf,xlsx,pptx]'
const IS_WIN = process.platform === 'win32'

function log(...args) {
  console.warn('[dsh-file-upload]', ...args)
}

/** Candidate dirs for the venv, first writable wins. */
function candidateDirs() {
  const dirs = []
  if (process.env.DSH_HOME) dirs.push(join(process.env.DSH_HOME, 'markitdown'))
  dirs.push(join(homedir(), '.dsh', 'markitdown'))
  dirs.push(join(PKG_ROOT, '.markitdown-venv'))
  return dirs
}

function markerPath(dir) {
  return join(dir, MARKER_NAME)
}

/** Read a previously written marker, if any. */
export function readMarker() {
  for (const dir of candidateDirs()) {
    try {
      const raw = readFileSync(markerPath(dir), 'utf8')
      const data = JSON.parse(raw)
      if (data.bin && existsSync(data.bin)) return data.bin
    } catch {
      // keep scanning
    }
  }
  return ''
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().slice(0, 300)
    throw new Error(`${cmd} exited ${res.status}: ${detail}`)
  }
  return res.stdout || ''
}

function findPython() {
  const candidates = IS_WIN ? ['py', 'python'] : ['python3', 'python']
  for (const bin of candidates) {
    try {
      const out = run(bin, ['--version'], { timeout: 10000 })
      const m = /Python (\d+)\.(\d+)/.exec(out)
      if (m) {
        const major = Number(m[1])
        const minor = Number(m[2])
        if (major > 3 || (major === 3 && minor >= 10)) return { bin, version: `${major}.${minor}` }
        log(`Python ${major}.${minor} is too old for MarkItDown (>= 3.10 required); skipping CLI install`)
        return null
      }
    } catch {
      // try next candidate
    }
  }
  log('no usable Python found; MarkItDown CLI not installed (bundled engine remains available)')
  return null
}

function pickWritableDir() {
  for (const dir of candidateDirs()) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.probe'), 'ok')
      return dir
    } catch {
      // next candidate
    }
  }
  return ''
}

/** Install (or verify) the MarkItDown CLI. Returns the CLI path or ''. */
export function installMarkitdown(force = false) {
  const existing = readMarker()
  if (existing !== '' && !force) return existing

  const py = findPython()
  if (py === null) return ''

  const dir = pickWritableDir()
  if (dir === '') {
    log('no writable directory for the MarkItDown venv; skipping CLI install')
    return ''
  }

  const venv = join(dir, 'venv')
  const binDir = IS_WIN ? join(venv, 'Scripts') : join(venv, 'bin')
  const cli = join(binDir, IS_WIN ? 'markitdown.exe' : 'markitdown')
  const pip = join(binDir, IS_WIN ? 'pip.exe' : 'pip')

  try {
    if (!existsSync(cli)) {
      log(`setting up isolated Python ${py.version} venv at ${venv} …`)
      run(py.bin, ['-m', 'venv', venv], { timeout: 120000 })
      log(`installing ${EXTRAS} (one-time) …`)
      run(pip, ['install', '-q', EXTRAS], { timeout: 600000 })
    }
    // Verify the CLI runs (`--version` is a faster entry than `--help` on
    // first run, which imports the full converter registry).
    run(cli, ['--version'], { timeout: 60000 })
    writeFileSync(
      markerPath(dir),
      JSON.stringify({ bin: cli, version: process.env.npm_package_version ?? '0.1.0', installedAt: new Date().toISOString() }),
      'utf8'
    )
    log(`MarkItDown CLI installed: ${cli}`)
    return cli
  } catch (err) {
    log(`MarkItDown CLI install failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

// Run when invoked directly (postinstall / manual).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  installMarkitdown(process.argv.includes('--force'))
}
