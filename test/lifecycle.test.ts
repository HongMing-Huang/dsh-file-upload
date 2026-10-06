import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../src/index.ts'
import { createUploadHandler, createSweeper } from '../src/upload.ts'

/**
 * A Cordis context just real enough to run `apply()`: every injected service is
 * present as a recording stub, and the services the plugin reaches optionally
 * (`llm`, `agents`) answer undefined. This is what makes the startup path
 * testable at all — the `sweepIntervalMs` bug below only appeared when `apply()`
 * actually ran.
 */
function stubContext() {
  const seen: {
    tools: Array<{ name: string; output?: { render?: unknown } }>
    routes: unknown[]
    promptSections: unknown[]
    dispose: Array<() => void>
  } = { tools: [], routes: [], promptSections: [], dispose: [] }
  const ctx = {
    systemPrompt: { section: (s: unknown) => { seen.promptSections.push(s); return () => {} } },
    tools: { register: (t: { name: string }) => { seen.tools.push(t); return () => {} }, get: () => undefined },
    webServer: { register: (r: unknown) => { seen.routes.push(r); return () => {} } },
    sessions: { get: () => undefined, list: () => [] },
    credentials: { resolve: async () => undefined },
    get: () => undefined,
    effect: (fn: () => unknown) => { fn(); return () => {} },
    on: (event: string, fn: () => void) => { if (event === 'dispose') seen.dispose.push(fn); return () => {} }
  }
  return { ctx, seen }
}

test('plugin manifest: name matches the bundle row id and inject lists only hard dependencies', () => {
  assert.equal(name, 'dsh-file-upload')
  // `fs` must NOT be here: the plugin never touches ctx.fs, it reaches the
  // filesystem through the interface passed to defineReadDocumentTool.
  assert.deepEqual([...inject].sort(), ['credentials', 'sessions', 'systemPrompt', 'tools', 'webServer'])
  assert.ok(!inject.includes('fs'), 'fs is not a hard dependency of this plugin')
})

test('apply: sweepIntervalMs 0 is accepted (it means "disable the sweep")', () => {
  // Regression: this used to throw `sweepIntervalMs must be a positive integer`,
  // so the setting the schema documents as valid crashed the plugin at startup.
  const { ctx, seen } = stubContext()
  const config = new Config({ sweepIntervalMs: 0 })
  assert.equal(config.sweepIntervalMs, 0)
  assert.doesNotThrow(() => apply(ctx, config))
  assert.equal(seen.tools.length, 1)
  assert.equal(seen.routes.length, 1)
  assert.equal(seen.promptSections.length, 1)
  assert.equal(seen.dispose.length, 1)
})

test('apply: a negative sweepIntervalMs is still refused', () => {
  const { ctx } = stubContext()
  assert.throws(() => apply(ctx, new Config({ sweepIntervalMs: -1 })), /sweepIntervalMs must be a non-negative integer/)
})

test('apply: the other positive-only fields still refuse zero', () => {
  for (const field of ['uploadMaxBytes', 'uploadTtlMs', 'maxConcurrentUploads', 'readLimit'] as const) {
    const { ctx } = stubContext()
    assert.throws(
      () => apply(ctx, new Config({ [field]: 0 })),
      new RegExp(`${field} must be a positive integer`),
      `${field}=0 should be refused`
    )
  }
})

test('apply: the registered tool is read_document with a render function', () => {
  const { ctx, seen } = stubContext()
  apply(ctx, new Config({ sweepIntervalMs: 0 }))
  const tool = seen.tools[0]
  assert.equal(tool.name, 'read_document')
  assert.equal(typeof tool.output?.render, 'function')
})

test('createSweeper: a zero interval disables sweeping and returns an inert disposer', () => {
  const dispose = createSweeper(['/nonexistent-root'], 1000, 0)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('createSweeper: a negative interval is the same as disabled, not a timer', () => {
  const dispose = createSweeper(['/nonexistent-root'], 1000, -1)
  assert.doesNotThrow(() => dispose())
})

test('createUploadHandler: the assembled route handler is callable', () => {
  const handler = createUploadHandler({
    maxBytes: 1024,
    allowedExtensions: [],
    ttlMs: 1000,
    sweepIntervalMs: 0,
    maxConcurrent: 1,
    defaultDir: '/tmp/dsh-upload-handler-contract',
    sessionCwd: () => undefined
  })
  assert.equal(typeof handler, 'function')
})
