/**
 * Postinstall patch: markitdown-node's ESM bundle ships one bare
 * `require("node-pptx-parser")` (dist/index.mjs) which throws
 * `require is not defined` in pure-ESM Node processes. Rewrite it to a
 * createRequire call so the bundled engine loads everywhere. Idempotent.
 *
 * Any failure (package absent, layout changed, read/write error) is a
 * warning, never a hard failure — postinstall must not kill the install.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

try {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('markitdown-node') // → dist/index.cjs via exports
  const pkgDir = dirname(dirname(entry)) // strip /dist/index.cjs
  const mjs = join(pkgDir, 'dist', 'index.mjs')

  let source = readFileSync(mjs, 'utf8')
  if (source.includes('createRequire')) {
    console.log('[dsh-file-upload] markitdown-node already patched')
  } else if (source.includes('const pptxParserModule = require("node-pptx-parser");')) {
    source = source.replace(
      /^const pptxParserModule = require\("node-pptx-parser"\);/m,
      'import { createRequire as __cr } from "node:module";\nconst pptxParserModule = __cr(import.meta.url)("node-pptx-parser");',
    )
    writeFileSync(mjs, source)
    console.log('[dsh-file-upload] markitdown-node patched (bare require → createRequire)')
  } else {
    console.log('[dsh-file-upload] markitdown-node shape changed upstream — patch skipped, verify PPTX path')
  }
} catch (err) {
  console.warn(`[dsh-file-upload] markitdown-node patch skipped: ${err?.message ?? err}`)
  // exit 0 — patching is best-effort; runtime falls back to the CJS path
}
