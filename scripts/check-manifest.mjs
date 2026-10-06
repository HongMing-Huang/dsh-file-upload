// Manifest and packaging self-check: the invariants a DSH plugin must satisfy
// to be installable and loadable, asserted without booting an app.
//
// Every rule below exists because this project got it wrong at least once and
// the failure was silent — a wrong client `inject` produced no ordering edge,
// a peer range outside the runtime refused every install, an unchecked config
// key quietly fell back to a schema default.
//
// Two modes:
//   node scripts/check-manifest.mjs            # check the working tree
//   node scripts/check-manifest.mjs <pkg-dir>  # check an unpacked package dir
//
// Exit code 0 = every invariant holds. Non-zero = at least one FAIL.

import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

/** Collected results; each entry is { level, rule, detail }. */
const results = []
const pass = (rule, detail = '') => results.push({ level: 'pass', rule, detail })
const fail = (rule, detail) => results.push({ level: 'fail', rule, detail })
const warn = (rule, detail) => results.push({ level: 'warn', rule, detail })

/** The services this plugin injects, sourced from the host half. */
const HOST_INJECT_FALLBACK = ['tools', 'fs', 'systemPrompt', 'webServer', 'sessions', 'credentials']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Names of the packages a local DSH installation ships, or undefined when no
 * installation is reachable.
 *
 * The payload is an Electron asar: a pickle of four uint32 lengths, then that
 * many bytes of JSON describing the tree. Only the header is parsed, never the
 * 100+ MB body.
 *
 * @returns the set of package names under `@deepseek-ai`, or undefined.
 */
function runtimeAsarFiles() {
  const asars = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    join(process.env.HOME ?? '', '.dsh/app.asar')
  ].filter((p) => p !== '' && existsSync(p))
  for (const asar of asars) {
    try {
      const fd = openSync(asar, 'r')
      try {
        const head = Buffer.alloc(16)
        readSync(fd, head, 0, 16, 0)
        const jsonSize = head.readUInt32LE(12)
        if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) continue
        const json = Buffer.alloc(jsonSize)
        readSync(fd, json, 0, jsonSize, 16)
        const header = JSON.parse(json.toString('utf8'))
        const dir = header?.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files
        if (dir === undefined) continue
        return dir
      } finally {
        closeSync(fd)
      }
    } catch {
      // A malformed or unreadable payload is "no runtime", not a failure.
    }
  }
  return undefined
}

/**
 * Names of the packages a local DSH installation ships, or undefined when no
 * installation is reachable.
 *
 * @returns the set of package names under `@deepseek-ai`, or undefined.
 */
function runtimePackageNames() {
  const dir = runtimeAsarFiles()
  if (dir === undefined) return undefined
  const names = new Set()
  for (const name of Object.keys(dir)) names.add(`@deepseek-ai/${name}`)
  return names.size > 0 ? names : undefined
}

/**
 * Names one shipped package exports, read from its bundled `lib/index.js`.
 *
 * @param pkg - package name under `@deepseek-ai`.
 * @returns the exported names, or undefined when they cannot be read.
 */
function runtimeExportsOf(pkg) {
  const dir = runtimeAsarFiles()
  const short = pkg.replace('@deepseek-ai/', '')
  const entry = dir?.[short]?.files?.lib?.files?.['index.js']
  if (entry === undefined || typeof entry.offset !== 'string') return undefined
  const asar = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  try {
    const fd = openSync(asar, 'r')
    try {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      const base = 16 + head.readUInt32LE(12)
      const buf = Buffer.alloc(Number(entry.size))
      readSync(fd, buf, 0, buf.length, base + Number(entry.offset))
      const text = buf.toString('utf8')
      const blocks = [...text.matchAll(/export\s*\{([^}]*)\}/g)]
      if (blocks.length === 0) return undefined
      const names = new Set()
      for (const name of blocks.at(-1)[1].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/).pop()?.trim()
        if (trimmed) names.add(trimmed)
      }
      return names.size > 0 ? names : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

if (!existsSync(join(root, 'package.json'))) {
  console.error(`check-manifest: no package.json under ${root}`)
  process.exit(2)
}

const pkg = readJson(join(root, 'package.json'))
const dsh = pkg.dsh ?? {}

// 1. Every path the manifest exports or ships must exist in the package.
{
  const declared = []
  if (typeof pkg.main === 'string') declared.push(['main', pkg.main])
  if (typeof pkg.types === 'string') declared.push(['types', pkg.types])
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (typeof value === 'string') declared.push([`exports["${key}"]`, value])
    else for (const [cond, target] of Object.entries(value)) declared.push([`exports["${key}"].${cond}`, target])
  }
  const missing = declared.filter(([, rel]) => !existsSync(join(root, rel)))
  if (missing.length === 0) pass('export-targets-exist', `${declared.length} declared target(s) present`)
  else fail('export-targets-exist', missing.map(([k, v]) => `${k} -> ${v}`).join(', '))
}

// 2. TypeScript consumers need BOTH a `types` field and the exports `types`
//    condition; the tarball shipping .d.ts while `types` was null is exactly
//    the bug this guards.
{
  const mainExport = pkg.exports?.['.']
  const hasTypesCondition = typeof mainExport === 'object' && mainExport !== null && typeof mainExport.types === 'string'
  if (typeof pkg.types === 'string' && hasTypesCondition) pass('types-resolvable', `types=${pkg.types}`)
  else fail('types-resolvable', `types=${JSON.stringify(pkg.types)} exports["."]=${JSON.stringify(mainExport)}`)
}

// 3. The bundle patch file must exist and must actually insert a row.
{
  const patch = dsh.bundle?.patch
  const files = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  if (files.length === 0) fail('bundle-patch', 'dsh.bundle.patch is not a path or list of paths')
  else {
    const missing = files.filter((f) => !existsSync(join(root, f)))
    if (missing.length > 0) fail('bundle-patch', `missing patch file(s): ${missing.join(', ')}`)
    else {
      const text = files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n')
      if (!/^\s*-\s*insert:/m.test(text)) fail('bundle-patch', 'patch declares no `insert:` entry, so it would add no row')
      else pass('bundle-patch', `${files.join(', ')} inserts a row`)
    }
  }
}

// 4. The row id must equal the host half's exported cordis `name` — the rule
//    cordis.patch.yml states in its own comment, and which was violated once.
{
  const entryCandidates = ['src/index.ts', 'lib/index.js']
  const entry = entryCandidates.map((p) => join(root, p)).find((p) => existsSync(p))
  const patch = dsh.bundle?.patch
  const patchFile = typeof patch === 'string' ? join(root, patch) : undefined
  if (entry === undefined || patchFile === undefined || !existsSync(patchFile)) {
    warn('row-id-matches-name', 'could not locate entry or patch to compare')
  } else {
    const entryText = readFileSync(entry, 'utf8')
    const patchText = readFileSync(patchFile, 'utf8')
    // Prefer the compiled/`: string` form, fall back to the TS const.
    const nameMatch = /name\s*=\s*['"]([^'"]+)['"]/.exec(entryText)
    const idMatch = /^\s*-\s*id:\s*(\S+)/m.exec(patchText)
    if (nameMatch === null || idMatch === null) warn('row-id-matches-name', 'could not parse name or row id')
    else if (nameMatch[1] === idMatch[1]) pass('row-id-matches-name', `id === name === ${idMatch[1]}`)
    else fail('row-id-matches-name', `row id "${idMatch[1]}" != exported name "${nameMatch[1]}"`)
  }
}

// 5. A generic row id collides with a shipped row. `file-upload` belongs to
//    @deepseek-ai/dsh-web-app; ids are addressed by id, so a duplicate makes
//    every id-targeted override ambiguous.
{
  const KNOWN_SHIPPED_IDS = new Set(['file-upload'])
  const patch = dsh.bundle?.patch
  const patchFile = typeof patch === 'string' ? join(root, patch) : undefined
  if (patchFile !== undefined && existsSync(patchFile)) {
    const ids = [...readFileSync(patchFile, 'utf8').matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
    const collisions = ids.filter((id) => KNOWN_SHIPPED_IDS.has(id))
    if (collisions.length === 0) pass('no-shipped-id-collision', `${ids.length} row id(s), none shipped-generic`)
    else fail('no-shipped-id-collision', `row id(s) also used by a shipped bundle: ${collisions.join(', ')}`)
  }
}

// 6. Peer ranges must not be narrower than the runtime this plugin targets.
//    `^0.1.0-rc.6` can never match 0.2.x, which refused every install.
{
  const DSH_PEERS = ['@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-credentials']
  const runtime = (() => {
    // Read the version the launcher ships, if a DSH install is reachable.
    const candidates = [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/versions.json'
    ]
    for (const c of candidates) {
      if (!existsSync(c)) continue
      try {
        const v = readJson(c)
        if (typeof v.dsh === 'string') return v.dsh
      } catch { /* ignore */ }
    }
    return undefined
  })()
  const peers = pkg.peerDependencies ?? {}
  const bad = []
  for (const name of DSH_PEERS) {
    const range = peers[name]
    if (typeof range !== 'string') { bad.push(`${name}: undeclared`); continue }
    // A caret on an 0.x prerelease pins the minor and admits no higher minor.
    const caretNarrow = /^\^\s*0\./.test(range)
    // An explicit upper bound below 0.3 would exclude the current runtime.
    const upper = /<\s*0\.(\d+)/.exec(range)
    if (caretNarrow) bad.push(`${name}: "${range}" pins the 0.x minor (^0.y.z admits no other minor)`)
    else if (upper !== null && Number(upper[1]) <= 2) bad.push(`${name}: "${range}" excludes the 0.3 runtime line`)
  }
  if (bad.length === 0) pass('peer-range-admits-runtime', DSH_PEERS.map((n) => `${n}@${peers[n]}`).join(', ') + (runtime !== undefined ? ` (launcher dsh=${runtime})` : ''))
  else fail('peer-range-admits-runtime', bad.join('; '))
}

// 7. dsh.client: platform is required, and every declared name must be a real
//    package (a typo'd package produced no ordering edge and no row retention).
{
  const client = dsh.client
  if (client === undefined) {
    warn('client-declaration', 'no dsh.client declaration (host-only plugin)')
  } else if (typeof client.platform !== 'string') {
    fail('client-declaration', 'dsh.client.platform must be a string')
  } else {
    const seen = new Set()
    const unknown = []
    const runtime = runtimePackageNames()
    for (const field of ['inject', 'external']) {
      for (const name of client[field] ?? []) {
        if (seen.has(name)) continue
        seen.add(name)
        const inNodeModules = existsSync(join(root, 'node_modules', ...name.split('/')))
        // A shipped-runtime package is authority: it exists even when this
        // checkout has not installed it.
        const inRuntime = runtime?.has(name) ?? false
        if (!inNodeModules && !inRuntime) unknown.push(`${field}:${name}`)
      }
    }
    if (unknown.length === 0) {
      const via = runtime === undefined ? 'resolvable locally' : `checked against ${runtime.size} shipped packages`
      pass('client-declaration', `platform=${client.platform}, ${seen.size} named package(s) ${via}`)
    } else if (runtime === undefined) {
      warn('client-declaration', `no DSH install to consult and not installed locally, cannot prove these exist: ${unknown.join(', ')}`)
    } else {
      fail('client-declaration', `named package(s) absent from the shipped runtime: ${unknown.join(', ')}`)
    }
    // The client bundle must exist for a web client half.
    const clientExport = pkg.exports?.['./client']
    const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (typeof target !== 'string') fail('client-bundle-declared', 'dsh.client present but exports["./client"] is missing')
    else if (!existsSync(join(root, target))) fail('client-bundle-declared', `exports["./client"] -> ${target} does not exist (run pnpm build)`)
    else pass('client-bundle-declared', target)
  }
}

// 8. Patch config keys must all exist in the Config schema, and vice versa is
//    only a warning (a schema key with a default may be omitted on purpose).
{
  const patch = dsh.bundle?.patch
  const patchFile = typeof patch === 'string' ? join(root, patch) : undefined
  const entry = join(root, 'src/index.ts')
  if (patchFile !== undefined && existsSync(patchFile) && existsSync(entry)) {
    const patchText = readFileSync(patchFile, 'utf8')
    const configBlock = /config:\s*\n((?:\s+.*\n)+)/.exec(patchText)
    const patchedKeys = new Set(
      (configBlock?.[1] ?? '')
        .split('\n')
        .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(l)?.[1])
        .filter(Boolean)
    )
    const schemaKeys = new Set([...readFileSync(entry, 'utf8').matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\./gm)].map((m) => m[1]))
    if (schemaKeys.size === 0) warn('patch-config-keys', 'could not parse the Config schema')
    else {
      const unknownKeys = [...patchedKeys].filter((k) => !schemaKeys.has(k))
      const omitted = [...schemaKeys].filter((k) => !patchedKeys.has(k))
      if (unknownKeys.length > 0) fail('patch-config-keys', `patch sets key(s) absent from Config: ${unknownKeys.join(', ')}`)
      else pass('patch-config-keys', `${patchedKeys.size}/${schemaKeys.size} schema keys set by the patch` + (omitted.length > 0 ? `; ${omitted.length} left to defaults: ${omitted.join(', ')}` : ''))
    }
  }
}

// 9. The published file list must actually include both halves.
{
  const files = pkg.files
  if (!Array.isArray(files)) warn('published-files', 'no `files` field; npm would publish everything not ignored')
  else {
    const needed = ['lib', 'cordis.patch.yml']
    const missing = needed.filter((n) => !files.includes(n))
    if (missing.length > 0) fail('published-files', `files[] omits: ${missing.join(', ')}`)
    else pass('published-files', files.join(', '))
  }
}

// 10. Every primitive the client actually uses must be a name the runtime
//     exports. The client once imported IconPaperclipOutline16 and
//     IconCloseOutline16, which the primitives package does not export — both
//     resolved to undefined and React rendered empty buttons, with nothing in
//     the build or the tests to say so.
{
  const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
  const bundle = join(root, 'lib/client.js')
  const stub = join(root, 'src/client/client-ui-primitives.d.ts')
  if (!existsSync(bundle)) {
    warn('runtime-primitives-exist', 'lib/client.js absent (run pnpm build)')
  } else {
    const text = readFileSync(bundle, 'utf8')
    const binding = new RegExp(`var\\s+([A-Za-z0-9_$]+)\\s*=\\s*__require\\("${PRIMITIVES.replace(/[/@]/g, (c) => '\\' + c)}"\\)`).exec(text)
    const used = new Set()
    if (binding !== null) {
      const re = new RegExp(`\\b${binding[1]}\\.([A-Za-z0-9_$]+)`, 'g')
      for (const m of text.matchAll(re)) used.add(m[1])
    }
    const exported = runtimeExportsOf(PRIMITIVES)
    // What the stub declares must also be what the bundle uses, or the two
    // drift and the typecheck stops describing the real dependency.
    const declared = existsSync(stub)
      ? new Set([...readFileSync(stub, 'utf8').matchAll(/export function ([A-Za-z0-9_$]+)/g)].map((m) => m[1]))
      : undefined
    if (used.size === 0) warn('runtime-primitives-exist', 'no primitive usage found in the bundle')
    else if (exported === undefined) warn('runtime-primitives-exist', `no runtime to check ${[...used].join(', ')} against`)
    else {
      const absent = [...used].filter((n) => !exported.has(n))
      const undeclared = declared === undefined ? [] : [...used].filter((n) => !declared.has(n))
      if (absent.length > 0) fail('runtime-primitives-exist', `not exported by ${PRIMITIVES}: ${absent.join(', ')}`)
      else if (undeclared.length > 0) fail('runtime-primitives-exist', `used but missing from src/client/client-ui-primitives.d.ts: ${undeclared.join(', ')}`)
      else pass('runtime-primitives-exist', `${used.size} primitive(s) used, exported by the runtime and declared in the stub`)
    }
  }
}

const failures = results.filter((r) => r.level === 'fail')
const warnings = results.filter((r) => r.level === 'warn')
for (const r of results) {
  const tag = r.level === 'pass' ? 'ok  ' : r.level === 'warn' ? 'warn' : 'FAIL'
  console.log(`  ${tag}  ${r.rule.padEnd(28)} ${r.detail}`)
}
console.log(`\ncheck-manifest: ${results.length - failures.length - warnings.length} passed, ${warnings.length} warning(s), ${failures.length} failure(s)`)
process.exit(failures.length > 0 ? 1 : 0)
