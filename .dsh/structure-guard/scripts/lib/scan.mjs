// Structure snapshot builder.
//
// Walks a project tree, classifies every file, extracts the internal import
// graph, derives modules and conventions, and returns one plain JSON-serializable
// snapshot. Zero runtime dependencies; Node >= 20.
//
// The snapshot is the single source of truth for audit, drift diffing and the
// generated architecture digest, so its field order and array ordering are
// deterministic: same tree in, byte-identical JSON out (except `generatedAt`).

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SNAPSHOT_VERSION = 1;

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.turbo', '.next',
  '.nuxt', '.cache', '.pnpm-store', '.idea', '.vscode', '.DS_Store',
  // `coverage/` is deliberately NOT ignored: committing it is a finding.
  // Editor and tool caches are, because they are never part of a structure.
  // The guard's own state directory: analyzing it would report the analyzer.
  '.structure',
]);

// Directories that hold build output in most ecosystems. They are ignored only
// when a sibling source root exists, so a project that genuinely ships `lib/`
// as source is still measured.
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'lib', 'target', '.output', 'bin']);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.rb', '.php', '.pl', '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.proto', '.graphql', '.gql', '.css', '.scss', '.sass', '.less', '.styl',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.json', '.jsonc', '.json5', '.md', '.mdx', '.rst', '.txt', '.adoc', '.env',
  '.dockerfile', '.tf', '.gradle', '.m', '.mm', '.zig', '.ex', '.exs', '.erl',
  '.hs', '.lua', '.r', '.dart', '.scala', '.clj', '.nix', '.makefile', '.mk',
]);

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.rb', '.php', '.pl', '.sh', '.bash', '.zsh', '.ps1', '.sql',
  '.proto', '.graphql', '.gql', '.zig', '.ex', '.exs', '.erl', '.hs', '.lua', '.r',
  '.dart', '.scala', '.clj', '.m', '.mm',
]);

const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl']);

// Kinds whose line count means something to a reviewer. Lockfiles, generated
// bundles and vendored trees are counted as files and bytes, but never as LOC —
// a 5000-line lockfile would otherwise dominate every directory total.
const LOC_KINDS = new Set(['source', 'test', 'doc', 'config', 'other-text']);
const CONFIG_BASENAME = new Set([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'makefile', 'cmakelists.txt',
  'dockerfile', 'composer.json', 'gemfile', 'requirements.txt',
]);

const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go', '.rs', '.d.ts', '.d.mts', '.d.cts'];
// Names every ecosystem reuses by convention. Repeating them across modules is
// the convention working, not a duplicated responsibility.
const CONVENTIONAL_BASENAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs', 'index.d.ts',
  'index.vue', 'index.svelte', 'mod.rs', '__init__.py', 'main.go', 'main.rs', 'lib.rs',
  'index.css', 'index.html', 'index.spec.ts', 'index.test.ts',
]);

const RESOLVE_INDEX = ['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.mjs', 'index.cjs', '__init__.py', 'mod.rs', 'main.go'];

const MAX_GRAPH_FILE_BYTES = 2 * 1024 * 1024;

// ── file enumeration ────────────────────────────────────────────────────────

async function gitLsFiles(dir) {
  try {
    const { stdout } = await run('git', ['-C', dir, 'ls-files', '-co', '--exclude-standard', '-z'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    const files = stdout.split('\0').filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

async function walk(dir, root, ignore, out, depthGuard) {
  if (depthGuard > 40) return;
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (ignore.has(entry.name)) continue;
      await walk(rel, root, ignore, out, depthGuard + 1);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** Enumerate project files, preferring git's own view so .gitignore is honored. */
/**
 * Glob matcher for ignore patterns. `**` crosses directories, `*` does not, and
 * a pattern without a slash is a bare segment name (`node_modules`), which the
 * caller handles separately.
 */
function globMatch(pattern, path) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(path);
  } catch {
    return false;
  }
}

/**
 * Turn config `ignore` entries into one predicate. A bare name matches a path
 * segment anywhere (`node_modules`); anything with `*`, `?` or `/` is a glob
 * against the repository-relative path (`.dsh/structure-guard/**`).
 */
export function buildIgnoreFilter(patterns) {
  const segments = new Set();
  const globs = [];
  for (const raw of patterns ?? []) {
    const pattern = String(raw).trim();
    if (pattern === '') continue;
    if (!/[*?/]/.test(pattern)) segments.add(pattern);
    else globs.push(pattern);
  }
  return (rel) => {
    if (rel.split('/').some((seg) => segments.has(seg))) return true;
    return globs.some((glob) => globMatch(glob, rel));
  };
}

export async function listFiles(root, options = {}) {
  const ignore = new Set(DEFAULT_IGNORE);
  const isIgnored = buildIgnoreFilter(options.ignore ?? []);
  if (options.useGit !== false) {
    const tracked = await gitLsFiles(root);
    if (tracked) {
      const kept = tracked.filter((rel) => {
        if (rel.startsWith('.git/')) return false;
        if (rel.split('/').some((seg) => ignore.has(seg))) return false;
        return !isIgnored(rel);
      });
      kept.sort();
      return { files: kept, source: 'git' };
    }
  }
  const out = [];
  await walk('', root, ignore, out, 0);
  const kept = out.filter((rel) => !isIgnored(rel));
  kept.sort();
  return { files: kept, source: 'walk' };
}

// ── classification ──────────────────────────────────────────────────────────

function langOf(rel) {
  const ext = extname(rel).toLowerCase();
  const base = basename(rel).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
  if (base === 'makefile' || base === 'gnumakefile') return 'make';
  if (ext === '' && (base === 'license' || base === 'notice' || base === 'authors')) return 'text';
  switch (ext) {
    case '.ts': case '.mts': case '.cts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js': case '.mjs': case '.cjs': case '.jsx': return 'javascript';
    case '.vue': return 'vue';
    case '.svelte': return 'svelte';
    case '.py': case '.pyi': return 'python';
    case '.go': return 'go';
    case '.rs': return 'rust';
    case '.java': return 'java';
    case '.kt': case '.kts': return 'kotlin';
    case '.swift': return 'swift';
    case '.c': case '.h': case '.cc': case '.cpp': case '.hpp': return 'c-family';
    case '.cs': return 'csharp';
    case '.rb': return 'ruby';
    case '.php': return 'php';
    case '.sh': case '.bash': case '.zsh': return 'shell';
    case '.ps1': return 'powershell';
    case '.sql': return 'sql';
    case '.proto': return 'protobuf';
    case '.graphql': case '.gql': return 'graphql';
    case '.md': case '.mdx': case '.rst': case '.adoc': return 'markdown';
    case '.json': case '.jsonc': case '.json5': return 'json';
    case '.yaml': case '.yml': return 'yaml';
    case '.toml': return 'toml';
    case '.css': case '.scss': case '.sass': case '.less': case '.styl': return 'style';
    case '.html': case '.htm': case '.xml': return 'markup';
    default: return ext === '' ? 'unknown' : ext.slice(1);
  }
}

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing', 'dts-test']);

function isTestPath(rel) {
  const base = basename(rel);
  if (/\.(test|spec|it)\.[A-Za-z0-9]+$/.test(base)) return true;
  // Type-level test suites (`*.test-d.ts`, `dts-test/`) assert on types, not behaviour.
  if (/\.test-d\.[A-Za-z0-9]+$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.(py|go|ts|js)$/.test(base)) return true;
  if (/Test\.(java|kt|swift|cs)$/.test(base)) return true;
  const segments = rel.split('/');
  return segments.slice(0, -1).some((seg) => TEST_DIR_SEGMENTS.has(seg.toLowerCase()));
}

/** Public path classifier for tools that have paths but no files on disk. */
export function classifyPath(rel) {
  return classify(rel);
}

function classify(rel) {
  const ext = extname(rel).toLowerCase();
  const base = basename(rel);
  const lower = base.toLowerCase();
  const segments = rel.split('/');
  const lang = langOf(rel);

  if (lower.endsWith('.lock') || lower === 'package-lock.json' || lower === 'pnpm-lock.yaml'
    || lower === 'yarn.lock' || lower === 'go.sum' || lower === 'cargo.lock'
    || lower === 'poetry.lock' || lower === 'composer.lock' || lower === 'uv.lock') return { kind: 'lockfile', lang };
  if (segments.includes('vendor') || segments.includes('third_party') || segments.includes('node_modules')) return { kind: 'vendored', lang };
  // Test snapshots are committed on purpose (jest/vitest snapshot testing);
  // minified bundles and source maps are build output.
  if (/\.snap$/.test(lower)) return { kind: isTestPath(rel) ? 'test' : 'generated', lang };
  if (/\.(min\.(js|css)|map)$/.test(lower)) return { kind: 'generated', lang };
  if (SOURCE_EXT.has(ext) || STYLE_EXT.has(ext)) {
    return { kind: isTestPath(rel) ? 'test' : 'source', lang };
  }
  if (DOC_EXT.has(ext)) return { kind: 'doc', lang };
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.cfg'
    || ext === '.conf' || ext === '.env' || lower.startsWith('.') || CONFIG_BASENAME.has(lower)
    || lower.endsWith('.config.js') || lower.endsWith('.config.ts') || lower.endsWith('.config.mjs')
    || lower.endsWith('.config.cjs')) return { kind: 'config', lang };
  if (TEXT_EXT.has(ext)) return { kind: 'other-text', lang };
  return { kind: 'asset', lang };
}

// ── manifests ───────────────────────────────────────────────────────────────

async function readJsonSafe(abs) {
  try {
    return JSON.parse(await readFile(abs, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readTextSafe(abs, maxBytes = 512 * 1024) {
  try {
    const info = await stat(abs);
    if (info.size > maxBytes) return undefined;
    return await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

// ── measurement ─────────────────────────────────────────────────────────────

const CONTENT_CACHE_LIMIT = 256 * 1024 * 1024;
const MAX_MEASURE_BYTES = 8 * 1024 * 1024;
const SNIFF_BYTES = 8192;

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.psd',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus',
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.xz', '.tar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.wasm', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.db', '.sqlite',
  '.pyc', '.pyo', '.class', '.jar', '.war', '.o', '.a', '.obj',
  '.lockb', '.db-wal', '.pack', '.idx', '.node',
]);

/**
 * Measure one file: always its size, plus a line count when it is text.
 *
 * Text detection is a NUL-byte sniff over the first 8 KB rather than an
 * extension table, because extensionless files (`.gitignore`, `LICENSE`,
 * `Dockerfile`, `Makefile`) are structural artifacts a reviewer reads as text.
 * `wantContent` keeps the decoded string for the import-graph pass so large
 * trees are not read twice.
 */
async function measureFile(abs, wantContent) {
  const ext = extname(abs).toLowerCase();
  if (BINARY_EXT.has(ext) || ext === '.lockb') {
    try {
      return { bytes: (await stat(abs)).size, lines: 0 };
    } catch {
      return { bytes: 0, lines: 0 };
    }
  }
  let handle;
  try {
    handle = await open(abs, 'r');
    const size = (await handle.stat()).size;
    if (size === 0) return { bytes: 0, lines: 0, text: true };
    if (size > MAX_MEASURE_BYTES) return { bytes: size, lines: 0, text: false };
    const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    await handle.read(sniff, 0, sniff.length, 0);
    if (sniff.includes(0)) return { bytes: size, lines: 0, text: false };
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const content = buffer.toString('utf8');
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const keep = wantContent && size <= MAX_GRAPH_FILE_BYTES;
    return { bytes: size, lines: Math.max(lines, 0), text: true, content: keep ? content : undefined };
  } catch {
    return { bytes: 0, lines: 0 };
  } finally {
    await handle?.close();
  }
}

async function readManifests(root, files) {
  const has = (name) => files.includes(name) || files.some((f) => f.toLowerCase() === name);
  const manifests = { packages: [], python: false, go: false, rust: false, jvm: false };

  const pkg = await readJsonSafe(join(root, 'package.json'));
  manifests.rootPackage = pkg;
  if (pkg) {
    manifests.name = pkg.name;
    manifests.version = pkg.version;
    manifests.type = pkg.type ?? 'commonjs';
    manifests.exports = pkg.exports !== undefined;
    manifests.main = pkg.main;
    manifests.private = pkg.private === true;
    manifests.workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) ? pkg.workspaces.packages : [];
    manifests.scripts = Object.keys(pkg.scripts ?? {});
    manifests.scriptCommands = pkg.scripts ?? {};
    manifests.deps = Object.keys(pkg.dependencies ?? {});
    manifests.devDeps = Object.keys(pkg.devDependencies ?? {});
    manifests.peerDeps = Object.keys(pkg.peerDependencies ?? {});
    manifests.engines = pkg.engines;
    manifests.files = pkg.files;
    manifests.license = pkg.license;
    manifests.repository = Boolean(pkg.repository);
  }

  // Workspace members: any nested package.json / pyproject.toml / go.mod / Cargo.toml.
  for (const rel of files) {
    const base = basename(rel).toLowerCase();
    if (rel.includes('/') === false) continue;
    if (base === 'package.json') {
      const nested = await readJsonSafe(join(root, rel));
      manifests.packages.push({
        path: dirname(rel),
        name: nested?.name ?? dirname(rel),
        version: nested?.version,
        private: nested?.private === true,
        deps: Object.keys(nested?.dependencies ?? {}).length,
        peerDeps: Object.keys(nested?.peerDependencies ?? {}).length,
        depNames: Object.keys(nested?.dependencies ?? {}).slice(0, 40),
      });
    } else if (base === 'pyproject.toml' || base === 'setup.py') {
      manifests.python = true;
      manifests.packages.push({ path: dirname(rel), name: dirname(rel) });
    } else if (base === 'go.mod') {
      manifests.go = true;
      manifests.packages.push({ path: dirname(rel), name: dirname(rel) });
    } else if (base === 'cargo.toml') {
      manifests.rust = true;
      manifests.packages.push({ path: dirname(rel), name: dirname(rel) });
    } else if (base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts') {
      manifests.jvm = true;
      manifests.packages.push({ path: dirname(rel), name: dirname(rel) });
    }
  }
  manifests.packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  manifests.python = manifests.python || has('pyproject.toml') || has('setup.py') || files.some((f) => f.endsWith('.py'));
  manifests.go = manifests.go || has('go.mod') || files.some((f) => f.endsWith('.go'));
  manifests.rust = manifests.rust || has('cargo.toml') || files.some((f) => f.endsWith('.rs'));

  return manifests;
}

// ── import graph ────────────────────────────────────────────────────────────

const JS_IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:\brequire\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const PY_IMPORT_RE = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gm;
const GO_IMPORT_RE = /(?:^|\n)[ \t]*import[ \t]*(?:\(\s*([\s\S]*?)\)|"([^"]+)")/g;
const GO_QUOTED_RE = /"([^"]+)"/g;
const RS_USE_RE = /^[ \t]*(?:pub[ \t]+)?use[ \t]+(crate|super|self)::([\w:{}, \t*]+)/gm;

function extractSpecifiers(content, lang) {
  const out = [];
  if (lang === 'typescript' || lang === 'typescriptreact' || lang === 'javascript' || lang === 'vue' || lang === 'svelte') {
    for (const m of content.matchAll(JS_IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  } else if (lang === 'python') {
    for (const m of content.matchAll(PY_IMPORT_RE)) {
      if (m[1]) out.push(m[1]);
      else if (m[2]) for (const part of m[2].split(',')) out.push(part.trim().split(/\s+/)[0]);
    }
  } else if (lang === 'go') {
    for (const m of content.matchAll(GO_IMPORT_RE)) {
      const body = m[1] ?? m[2];
      if (!body) continue;
      if (m[1]) for (const q of body.matchAll(GO_QUOTED_RE)) out.push(q[1]);
      else out.push(body);
    }
  } else if (lang === 'rust') {
    for (const m of content.matchAll(RS_USE_RE)) out.push(`${m[1]}::${m[2]}`);
  }
  return out.filter((s) => typeof s === 'string' && s.length > 0);
}

function isRelative(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

// Directories that hold build output. An import that points into one is a
// reference to generated code, not a broken edge in the source graph.
const BUILD_OUTPUT_SEGMENTS = new Set(['dist', 'build', 'out', 'lib', 'target', '.output', 'dist-js', 'coverage']);

function stripImportQuery(spec) {
  return spec.split('?')[0].split('#')[0];
}

function pointsAtBuildOutput(spec) {
  const clean = stripImportQuery(spec);
  const segments = clean.split('/');
  const first = segments[0] === '.' || segments[0] === '..' ? segments[1] : segments[0];
  return BUILD_OUTPUT_SEGMENTS.has(first);
}

function resolveSpecifier(spec, fromRel, filesByPath) {
  if (!isRelative(spec)) return undefined;
  spec = stripImportQuery(spec);
  if (spec === '') return undefined;
  const base = dirname(fromRel);
  const target = normalize(join(base, spec).split(sep).join('/'));
  const candidates = [target];
  // TypeScript ESM writes `./x.js` for a source file that is really `./x.ts`.
  // Resolve through the stem so the dominant modern convention is not reported
  // as a broken edge.
  const ext = extname(target);
  const stems = ext ? [target.slice(0, -ext.length), target] : [target];
  for (const stem of stems) {
    for (const candidate of RESOLVE_EXT) candidates.push(stem + candidate);
    for (const index of RESOLVE_INDEX) candidates.push(`${stem}/${index}`);
  }
  for (const cand of candidates) if (filesByPath.has(cand)) return cand;
  return undefined;
}

/**
 * Resolve a Python import. `from .model import x` and `from pkg.mod import y`
 * both map onto file paths; the leading-dot count selects the base directory.
 */
function resolvePython(spec, fromRel, filesByPath) {
  const dots = (spec.match(/^\.+/) ?? [''])[0].length;
  const dotted = spec.slice(dots);
  if (dotted === '') return undefined;
  const relPath = dotted.replace(/\./g, '/');
  const bases = [];
  if (dots === 0) bases.push('');
  let dir = dirname(fromRel);
  for (let level = 0; level < Math.max(dots - 1, 0); level += 1) dir = normalize(`${dir}/..`);
  if (dots > 0 || dir !== '.') bases.push(dir === '.' ? '' : dir);
  for (const base of bases) {
    const target = normalize(base === '' ? relPath : `${base}/${relPath}`);
    for (const cand of [`${target}.py`, `${target}/__init__.py`, target]) {
      if (filesByPath.has(cand)) return cand;
    }
  }
  return undefined;
}

import { FUNCTION_LANGS, scanFunctions } from './functions.mjs';

/**
 * The directory that owns an `internal/` (or `_private`) subtree, i.e. the path
 * above the privacy marker. `undefined` when the target is not private, and an
 * empty string for a repository-root `internal/` (private to the whole repo).
 */
export function privacyOwner(target) {
  const segments = target.split('/');
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const seg = segments[i];
    if (seg === 'internal' || seg === 'internals') return segments.slice(0, i).join('/');
    if (/^_[a-z]/.test(seg)) return segments.slice(0, i).join('/');
  }
  return undefined;
}

// Roots that hold application, example, benchmark or test code. A library tree
// must never import from one of these (see references/industry-standards.md 3.4).
export const NON_LIBRARY_ROOTS = new Set([
  'apps', 'app', 'examples', 'example', 'test', 'tests', 'bench', 'benches',
  'benchmarks', 'playground', 'playgrounds', 'sample', 'samples', 'xtask', 'fuzz',
  'e2e', 'e2e-tests', 'integration', 'evals', 'demos', 'site', 'website', 'docs',
]);
export const LIBRARY_ROOTS = new Set(['packages', 'crates', 'libs', 'src', 'pkg', 'lib']);

// Directories that hold build output. `build/` is deliberately absent: several
// reference repositories keep real release tooling there.
const BUILD_OUTPUT_DIRS = new Set(['dist', '.next', '.nuxt', '.output', 'coverage', 'target', '.turbo']);

function normalize(p) {
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Detect cycles with an iterative Tarjan SCC; returns arrays of file paths. */
function findCycles(nodes, adjacency, limit = 40) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, childIdx] = frame;
      if (childIdx === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const children = adjacency.get(node) ?? [];
      let advanced = false;
      for (let i = childIdx; i < children.length; i += 1) {
        const child = children[i];
        if (!index.has(child)) {
          frame[1] = i + 1;
          work.push([child, 0]);
          advanced = true;
          break;
        } else if (onStack.has(child)) {
          low.set(node, Math.min(low.get(node), index.get(child)));
        }
      }
      if (advanced) continue;
      if (low.get(node) === index.get(node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === node) break;
        }
        if (component.length > 1) sccs.push(component.sort());
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
    }
  }
  sccs.sort((a, b) => b.length - a.length);
  return sccs.slice(0, limit);
}

// ── naming conventions ──────────────────────────────────────────────────────

export function namingStyle(name) {
  const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
  if (stem.includes('_') && /^[a-z0-9_]+$/.test(stem)) return 'snake';
  if (stem.includes('-') && /^[a-z0-9-]+$/.test(stem)) return 'kebab';
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(stem)) return 'camel';
  if (/^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(stem)) return 'pascal';
  if (/^[a-z0-9]+$/.test(stem)) return 'flat';
  if (/^[A-Z0-9_]+$/.test(stem)) return 'screaming';
  return 'other';
}

// ── main scan ───────────────────────────────────────────────────────────────

/**
 * @param {string} root absolute project directory
 * @param {object} options { ignore?: string[], useGit?: boolean, graph?: boolean, maxFiles?: number }
 */
export async function scan(root, options = {}) {
  const startedAt = Date.now();
  const { files, source: fileSource } = await listFiles(root, options);
  const maxFiles = options.maxFiles ?? 60000;
  const truncated = files.length > maxFiles;
  const scoped = truncated ? files.slice(0, maxFiles) : files;

  const manifests = await readManifests(root, scoped);
  const filesByPath = new Set(scoped);

  const entries = [];
  const kindCount = {};
  const langCount = {};
  const langLoc = {};
  const dirStats = new Map();
  const naming = { kebab: 0, snake: 0, camel: 0, pascal: 0, flat: 0, screaming: 0, other: 0 };
  const basenameIndex = new Map();
  const namingByExt = new Map();
  const contentCache = new Map();
  let cacheBytes = 0;
  let maxDepth = 0;
  let totalBytes = 0;

  for (const rel of scoped) {
    const cls = classify(rel);
    kindCount[cls.kind] = (kindCount[cls.kind] ?? 0) + 1;
    const segments = rel.split('/');
    const depth = segments.length - 1;
    if (depth > maxDepth) maxDepth = depth;
    const wantsContent = options.graph !== false && (cls.kind === 'source' || cls.kind === 'test');
    const measured = await measureFile(join(root, rel), wantsContent);
    const { bytes, lines } = measured;
    entries.push({ path: rel, kind: cls.kind, lang: cls.lang, bytes, lines });
    if (measured.content !== undefined && cacheBytes + bytes <= CONTENT_CACHE_LIMIT) {
      contentCache.set(rel, measured.content);
      cacheBytes += bytes;
    }
    totalBytes += bytes;
    langCount[cls.lang] = (langCount[cls.lang] ?? 0) + 1;
    if (cls.kind === 'source' || cls.kind === 'test') langLoc[cls.lang] = (langLoc[cls.lang] ?? 0) + lines;

    // Directory aggregation, including every ancestor.
    for (let i = 1; i <= segments.length; i += 1) {
      const dir = segments.slice(0, i).join('/');
      const bucket = dirStats.get(dir) ?? { files: 0, loc: 0, sourceFiles: 0, testFiles: 0, directFiles: 0 };
      bucket.files += 1;
      bucket.loc += LOC_KINDS.has(cls.kind) ? lines : 0;
      if (cls.kind === 'source') bucket.sourceFiles += 1;
      if (cls.kind === 'test') bucket.testFiles += 1;
      if (i === segments.length - 1 || segments.length === 1) bucket.directFiles += 1;
      dirStats.set(dir, bucket);
    }

    if (cls.kind === 'source') {
      const style = namingStyle(basename(rel));
      naming[style] = (naming[style] ?? 0) + 1;
      const extKey = extname(rel).toLowerCase() || '(none)';
      const perExt = namingByExt.get(extKey) ?? {};
      perExt[style] = (perExt[style] ?? 0) + 1;
      namingByExt.set(extKey, perExt);
      const key = basename(rel).toLowerCase();
      if (CONVENTIONAL_BASENAMES.has(key)) continue;
      const list = basenameIndex.get(key) ?? [];
      list.push(rel);
      if (list.length <= 6) basenameIndex.set(key, list);
    }
  }

  // Reviewer-meaningful line count per file, used by every LOC aggregate below.
  for (const entry of entries) entry.loc = LOC_KINDS.has(entry.kind) ? entry.lines : 0;

  // ── import graph ────────────────────────────────────────────────────────
  const graph = {
    nodes: 0, edges: 0, unresolvedRelative: 0, unresolvedSource: 0, unresolvedTest: 0,
    external: 0, buildOutputRefs: 0, cycles: [], crossDirEdges: 0, unresolvedSamples: [],
  };
  const adjacency = new Map();
  const fanOut = new Map();
  const fanIn = new Map();
  const rawEdges = [];
  // Function-length census, measured on the same content the graph pass reads.
  const functionFloor = options.functionFloor ?? 120;
  const functionStats = { maxLines: 0, maxName: undefined, maxAt: undefined, long: 0, measured: 0 };
  const functionCandidates = [];
  if (options.graph !== false) {
    const sourceFiles = entries.filter((e) => (e.kind === 'source' || e.kind === 'test') && e.bytes <= MAX_GRAPH_FILE_BYTES);
    for (const entry of sourceFiles) {
      const cached = contentCache.get(entry.path);
      const content = cached !== undefined ? cached : await readTextSafe(join(root, entry.path), MAX_GRAPH_FILE_BYTES);
      contentCache.delete(entry.path);
      if (content === undefined) continue;
      if (entry.kind === 'source' && FUNCTION_LANGS.has(entry.lang)) {
        for (const fn of scanFunctions(content, entry.lang)) {
          if (fn.lines > functionStats.maxLines) {
            functionStats.maxLines = fn.lines;
            functionStats.maxAt = `${entry.path}:${fn.startLine}`;
            functionStats.maxName = fn.name;
          }
          if (fn.lines >= functionFloor) {
            functionStats.long += 1;
            functionCandidates.push({ path: entry.path, name: fn.name, lines: fn.lines, startLine: fn.startLine });
          }
        }
      }
      const specs = extractSpecifiers(content, entry.lang);
      const seen = new Set();
      for (const spec of specs) {
        let resolved;
        if (entry.lang === 'python') {
          resolved = resolvePython(spec, entry.path, filesByPath);
          if (resolved === undefined) {
            if (isRelative(spec)) {
              graph.unresolvedRelative += 1;
              if (entry.kind === 'test') graph.unresolvedTest += 1;
              else {
                graph.unresolvedSource += 1;
                if (graph.unresolvedSamples.length < 12) graph.unresolvedSamples.push(`${entry.path} -> ${spec}`);
              }
            } else graph.external += 1;
            continue;
          }
        } else {
          if (!isRelative(spec)) { graph.external += 1; continue; }
          resolved = resolveSpecifier(spec, entry.path, filesByPath);
          if (resolved === undefined) {
            if (pointsAtBuildOutput(spec)) {
              graph.buildOutputRefs = (graph.buildOutputRefs ?? 0) + 1;
            } else {
              graph.unresolvedRelative += 1;
              // Test files are full of string fixtures that look exactly like
              // import statements, so only production misses are actionable.
              if (entry.kind === 'test') graph.unresolvedTest += 1;
              else {
                graph.unresolvedSource += 1;
                if (graph.unresolvedSamples.length < 12) graph.unresolvedSamples.push(`${entry.path} -> ${spec}`);
              }
            }
            continue;
          }
        }
        if (resolved === entry.path || seen.has(resolved)) continue;
        seen.add(resolved);
        const list = adjacency.get(entry.path) ?? [];
        list.push(resolved);
        adjacency.set(entry.path, list);
        fanOut.set(entry.path, (fanOut.get(entry.path) ?? 0) + 1);
        fanIn.set(resolved, (fanIn.get(resolved) ?? 0) + 1);
        graph.edges += 1;
        if (dirname(entry.path) !== dirname(resolved)) graph.crossDirEdges += 1;
        // Every file-level edge is kept, not only cross-directory ones: a declared
        // module boundary can run between two files in the SAME directory (a flat
        // `src/`), and dropping those edges leaves the boundary rule blind exactly
        // where a small project needs it. Consumers filter for themselves.
        if (entry.path !== resolved && rawEdges.length < 40000) rawEdges.push({ from: entry.path, to: resolved });
      }
    }
    graph.nodes = adjacency.size;
    graph.cycles = findCycles([...adjacency.keys()], adjacency);
  }

  const largest = [...entries]
    .filter((e) => e.kind === 'source')
    .sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1))
    .slice(0, 25)
    .map((e) => ({ path: e.path, lines: e.lines, bytes: e.bytes }));

  const hottest = [...fanIn.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 25)
    .map(([path, count]) => ({ path, importedBy: count }));

  const duplicated = [...basenameIndex.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({ name, count: list.length, paths: list.slice().sort() }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, 20);

  const topLevel = [];
  const topLevelDirs = new Set(scoped.filter((f) => f.includes('/')).map((f) => f.split('/')[0]));
  for (const [dir, bucket] of dirStats) {
    if (!dir.includes('/')) {
      topLevel.push({ path: dir, type: topLevelDirs.has(dir) ? 'dir' : 'file', ...bucket });
    }
  }
  topLevel.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const sourceLoc = entries.filter((e) => e.kind === 'source').reduce((sum, e) => sum + e.lines, 0);
  const testLoc = entries.filter((e) => e.kind === 'test').reduce((sum, e) => sum + e.lines, 0);
  const docLoc = entries.filter((e) => e.kind === 'doc').reduce((sum, e) => sum + e.lines, 0);

  const presence = detectPresence(scoped, manifests);
  const conventions = detectConventions(scoped, entries, naming, manifests, namingByExt);
  const archetype = detectArchetype(scoped, manifests, topLevel);
  const modules = deriveModules(scoped, entries, adjacency, archetype, manifests);

  // Annotate the graph with module-level edges.
  const moduleOf = new Map();
  for (const mod of modules) for (const file of mod.files) moduleOf.set(file, mod.name);
  const moduleEdges = new Map();
  for (const [from, targets] of adjacency) {
    const fromMod = moduleOf.get(from) ?? '(root)';
    for (const to of targets) {
      const toMod = moduleOf.get(to) ?? '(root)';
      if (fromMod === toMod) continue;
      const key = `${fromMod} -> ${toMod}`;
      moduleEdges.set(key, (moduleEdges.get(key) ?? 0) + 1);
    }
  }
  for (const mod of modules) {
    mod.imports = [...moduleEdges.keys()]
      .filter((k) => k.startsWith(`${mod.name} -> `))
      .map((k) => k.split(' -> ')[1])
      .sort();
    mod.importedBy = [...moduleEdges.keys()]
      .filter((k) => k.endsWith(` -> ${mod.name}`))
      .map((k) => k.split(' -> ')[0])
      .sort();
    delete mod.files;
  }

  // Transient tables consumed by the rule engine in the same process. They are
  // stripped before a snapshot is persisted, because they are large and churn on
  // every edit while the aggregates above are what drift diffing needs.
  const dirStatsPlain = {};
  for (const [dir, bucket] of [...dirStats].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    dirStatsPlain[dir] = bucket;
  }
  const crossEdges = rawEdges
    .map((e) => ({ from: e.from, to: e.to, fromModule: moduleOf.get(e.from) ?? '(root)', toModule: moduleOf.get(e.to) ?? '(root)' }));

  // Privacy and isolation analysis over the same file-level edges.
  const internalViolations = [];
  const isolationViolations = [];
  let internalViolationCount = 0;
  let isolationViolationCount = 0;
  for (const edge of crossEdges) {
    const owner = privacyOwner(edge.to);
    if (owner !== undefined && owner !== '' && !edge.from.startsWith(`${owner}/`)) {
      internalViolationCount += 1;
      if (internalViolations.length < 15) internalViolations.push(`${edge.from} -> ${edge.to}`);
    }
    const fromRoot = edge.from.split('/')[0];
    const toRoot = edge.to.split('/')[0];
    if (LIBRARY_ROOTS.has(fromRoot) && NON_LIBRARY_ROOTS.has(toRoot) && fromRoot !== toRoot) {
      isolationViolationCount += 1;
      if (isolationViolations.length < 15) isolationViolations.push(`${edge.from} -> ${edge.to}`);
    }
  }
  graph.internalViolations = internalViolations;
  graph.internalViolationCount = internalViolationCount;
  graph.isolationViolations = isolationViolations;
  graph.isolationViolationCount = isolationViolationCount;

  const committedBuildOutput = scoped.filter((f) => f.split('/').some((seg) => BUILD_OUTPUT_DIRS.has(seg)));

  // Package-shape uniformity. Deviations in the corpus are never accidental, so
  // the shape of every workspace member is recorded and compared below.
  const packageShapes = manifests.packages.slice(0, 300).map((pkg) => {
    const prefix = pkg.path === '.' ? '' : `${pkg.path}/`;
    const memberFiles = prefix === '' ? [] : scoped.filter((f) => f.startsWith(prefix));
    return {
      path: pkg.path === '.' ? '(root)' : pkg.path,
      name: pkg.name,
      files: memberFiles.length,
      src: memberFiles.some((f) => /(^|\/)(src|lib)\//.test(f.slice(prefix.length))),
      tests: memberFiles.some((f) => isTestPath(f)),
      readme: memberFiles.some((f) => f.slice(prefix.length).toLowerCase() === 'readme.md'),
      deps: pkg.deps ?? 0,
    };
  });

  // A cycle confined to one module is a cohesion problem; a cycle that crosses
  // modules means the decomposition itself is wrong. Reviewers triage them
  // very differently, so the snapshot records both counts separately.
  const cycleSpans = graph.cycles.map((files) => {
    const mods = [...new Set(files.map((f) => moduleOf.get(f) ?? '(root)'))].sort();
    return { files, modules: mods, crossModule: mods.length > 1 };
  });
  graph.crossModuleCycles = cycleSpans.filter((c) => c.crossModule).slice(0, 12).map((c) => c.modules);
  graph.crossModuleCycleCount = cycleSpans.filter((c) => c.crossModule).length;
  graph.intraModuleCycleCount = cycleSpans.length - graph.crossModuleCycleCount;

  const languages = Object.entries(langLoc)
    .filter(([, loc]) => loc > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([lang, loc]) => ({ lang, loc }));

  const ignoreFilter = buildIgnoreFilter(options.ignore ?? []);
  const git = options.git === false ? undefined : await gitFacts(root, { exclude: ignoreFilter });

  const snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    fileSource,
    truncated,
    project: {
      name: manifests.name ?? basename(root),
      version: manifests.version,
      primaryLanguage: languages[0]?.lang ?? conventions.primaryLanguage,
      languages,
      archetype,
      packageManager: conventions.packageManager,
      moduleSystem: conventions.moduleSystem,
      workspaces: manifests.workspaces,
      nestedPackages: manifests.packages.slice(0, 200).map((p) => p.path),
      packageShapes,
      packages: manifests.packages.slice(0, 200).map((p) => ({
        path: p.path, name: p.name, private: p.private, deps: p.deps ?? 0, peerDeps: p.peerDeps ?? 0,
      })),
      scripts: manifests.scripts ?? [],
      scriptCommands: manifests.scriptCommands ?? {},
      dependencies: (manifests.deps ?? []).length,
      devDependencies: (manifests.devDeps ?? []).length,
      peerDependencies: (manifests.peerDeps ?? []).length,
      engines: manifests.engines,
      exportsMap: manifests.exports === true,
      publishedFiles: manifests.files,
      license: manifests.license,
      repositoryDeclared: manifests.repository === true,
    },
    metrics: {
      files: scoped.length,
      bytes: totalBytes,
      sourceFiles: kindCount.source ?? 0,
      testFiles: kindCount.test ?? 0,
      docFiles: kindCount.doc ?? 0,
      configFiles: kindCount.config ?? 0,
      assetFiles: kindCount.asset ?? 0,
      lockfiles: kindCount.lockfile ?? 0,
      generatedFiles: kindCount.generated ?? 0,
      committedBuildOutput: committedBuildOutput.length,
      longFunctionCount: functionStats.long,
      maxFunctionLines: functionStats.maxLines,
      maxFunctionName: functionStats.maxName,
      maxFunctionAt: functionStats.maxAt,
      vendoredFiles: kindCount.vendored ?? 0,
      sourceLoc,
      testLoc,
      docLoc,
      maxDepth,
      topLevelDirCount: topLevel.filter((t) => t.type === 'dir' && !t.path.startsWith('.')).length,
      topLevelEntryCount: topLevel.filter((t) => t.type === 'dir').length,
      topLevelFileCount: entries.filter((e) => !e.path.includes('/')).length,
      testToSourceRatio: (kindCount.source ?? 0) === 0 ? 0 : round2((kindCount.test ?? 0) / kindCount.source),
      testLocRatio: sourceLoc === 0 ? 0 : round2(testLoc / sourceLoc),
      avgSourceLines: (kindCount.source ?? 0) === 0 ? 0 : Math.round(sourceLoc / kindCount.source),
    },
    conventions,
    presence,
    topLevel,
    committedBuildOutput: committedBuildOutput.slice(0, 12).sort(),
    longestFunctions: functionCandidates.sort((a, b) => b.lines - a.lines).slice(0, 15),
    largestFiles: largest,
    mostImported: hottest,
    duplicatedBasenames: duplicated,
    modules,
    graph,
    git,
    scanMs: Date.now() - startedAt,
  };

  // Keep the full file table available to digest/drift without re-walking, but
  // out of the persisted snapshot body (it is large and churns constantly).
  snapshot.__entries = entries;
  snapshot.__dirStats = dirStatsPlain;
  snapshot.__crossEdges = crossEdges;
  snapshot.__moduleOf = moduleOf;
  snapshot.__rootPackage = manifests.rootPackage;
  snapshot.__fileSet = filesByPath;
  return snapshot;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function detectPresence(files, manifests = {}) {
  const lower = new Set(files.map((f) => f.toLowerCase()));
  const hasRoot = (name) => lower.has(name.toLowerCase());
  const hasAny = (pred) => files.some(pred);
  return {
    readme: hasAny((f) => !f.includes('/') && /^readme/i.test(basename(f))) || hasRoot('readme.md'),
    readmeZh: hasAny((f) => !f.includes('/') && /readme\.(zh|cn)/i.test(basename(f))),
    license: hasAny((f) => !f.includes('/') && /^licen[cs]e/i.test(basename(f))),
    changelog: hasAny((f) => !f.includes('/') && /^changelog/i.test(basename(f))),
    contributing: hasAny((f) => !f.includes('/') && /^contributing/i.test(basename(f))),
    architectureDoc: hasAny((f) => DOC_EXT.has(extname(f).toLowerCase())
      && (/^(architecture|design|structure|codebase-map|repo-structure|layout|overview)\b/i.test(basename(f))
        || /(^|\/)(InternalDocs|internal-docs|\.agents|doc|docs)\//i.test(f) && /^(architecture|structure|codebase-map|repo-structure)/i.test(basename(f)))),
    enforcementArtifacts: [
      ...files.filter((f) => /(^|\/)\.ls-lint\.(json|ya?ml)$/i.test(f)).map((f) => `${f} (naming rules)`),
      ...files.filter((f) => /(^|\/)\.import-restrictions$/i.test(f)).slice(0, 3).map((f) => `${f} (import boss)`),
      ...files.filter((f) => /(^|\/)\.eslint-plugin-local\//i.test(f)).slice(0, 1).map(() => '.eslint-plugin-local/ (repo-local lint rules)'),
      ...files.filter((f) => /(^|\/)(\.dependency-cruiser|dependency-cruise)\./i.test(f)).map((f) => `${f} (dependency-cruiser)`),
      ...files.filter((f) => /(^|\/)eslint\.config\.[cm]?[jt]s$/i.test(f)).map((f) => `${f} (flat lint config)`),
      ...files.filter((f) => /(^|\/)(nx\.json|turbo\.json)$/i.test(f)).map((f) => `${f} (task graph)`),
      ...files.filter((f) => /(^|\/)OWNERS$/i.test(f)).slice(0, 1).map(() => 'OWNERS files (per-directory ownership)'),
      ...files.filter((f) => /(^|\/)(api|apis)\/[^/]*\.txt$/i.test(f)).slice(0, 1).map(() => 'frozen public-API surface file'),
    ],
    security: hasAny((f) => !f.includes('/') && /^security/i.test(basename(f))),
    codeOfConduct: hasAny((f) => /^code[_-]?of[_-]?conduct/i.test(basename(f))),
    docsDir: files.some((f) => f.startsWith('docs/') || f.startsWith('doc/') || f.startsWith('website/')),
    // Instructions written for coding agents: the entry point that makes a repo
    // workable by an AI agent, and increasingly the place a project states its
    // own layout rules. 10 of the 18 reference repositories carry one.
    agentDocs: files.some((f) => /(^|\/)(AGENTS|CLAUDE|GEMINI|QWEN)\.md$/i.test(f)
      || f.startsWith('.agents/') || f.startsWith('.cursor/')
      || /(^|\/)\.github\/copilot-instructions\.md$/i.test(f)),
    adrDir: files.some((f) => /(^|\/)(adr|decisions|rfcs?)(\/|$)/i.test(f)),
    ci: files.some((f) => f.startsWith('.github/workflows/') || f.startsWith('.gitlab-ci') || f.startsWith('.circleci/')
      || basename(f) === 'azure-pipelines.yml' || f.startsWith('.woodpecker')),
    editorconfig: hasRoot('.editorconfig'),
    gitignore: hasRoot('.gitignore'),
    gitattributes: hasRoot('.gitattributes'),
    issueTemplates: files.some((f) => f.startsWith('.github/ISSUE_TEMPLATE/')),
    prTemplate: files.some((f) => /^\.github\/(pull_request_template|PULL_REQUEST_TEMPLATE)/i.test(f)),
    lockfile: files.some((f) => !f.includes('/') && /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|cargo\.lock|poetry\.lock|uv\.lock|composer\.lock)$/i.test(basename(f))),
    dockerfile: files.some((f) => /dockerfile/i.test(basename(f))),
    dockerCompose: files.some((f) => /^docker-compose/i.test(basename(f)) || /^compose\.ya?ml$/i.test(basename(f))),
    linterConfig: files.some((f) => /^(\.eslintrc|eslint\.config|biome\.json|\.ruff|ruff\.toml|\.flake8|\.pylintrc|golangci\.|\.rubocop|clippy\.toml|\.clang-format|\.prettierrc|prettier\.config)/i.test(basename(f))),
    formatterConfig: files.some((f) => /^(\.prettierrc|prettier\.config|\.editorconfig|\.clang-format|rustfmt\.toml|\.gofmt)/i.test(basename(f))),
    typeConfig: files.some((f) => /^tsconfig.*\.json$/i.test(basename(f)) || basename(f).toLowerCase() === 'mypy.ini' || basename(f).toLowerCase() === 'pyrightconfig.json'),
    testConfig: files.some((f) => /^(jest\.config|vitest\.config|pytest\.ini|tox\.ini|karma\.conf|\.mocharc|playwright\.config)/i.test(basename(f))),
    hooksConfig: files.some((f) => /^(\.husky|\.pre-commit-config\.yaml|lefthook\.yml|\.lintstagedrc|lint-staged\.config)/i.test(basename(f)) || f.startsWith('.husky/')),
    releaseAutomation: files.some((f) => /^(\.releaserc|release\.config|\.changeset)/i.test(basename(f)) || f.startsWith('.changeset/')),
    workspaceManifest: files.some((f) => !f.includes('/')
      && /^(pnpm-workspace\.yaml|lerna\.json|rush\.json|nx\.json|turbo\.json|go\.work)$/i.test(basename(f)))
      || (manifests.rootPackage?.workspaces !== undefined)
      || files.some((f) => !f.includes('/') && f.toLowerCase() === 'cargo.toml'),
    benchmarks: files.some((f) => /(^|\/)(bench|benches|benchmarks)(\/|$)/i.test(f)),
    examplesDir: files.some((f) => f.startsWith('examples/') || f.startsWith('example/') || f.startsWith('playground/')),
    i18n: files.some((f) => /(^|\/)(locales?|i18n|lang)(\/|$)/i.test(f)),
  };
}

export function detectConventions(files, entries, naming, manifests, namingByExt = new Map()) {
  const sourceEntries = entries.filter((e) => e.kind === 'source');
  const testEntries = entries.filter((e) => e.kind === 'test');
  const inTestDir = (p) => p.split('/').slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()));
  const inDir = testEntries.filter((t) => inTestDir(t.path)).length;
  const beside = testEntries.filter((t) => !inTestDir(t.path)
    && (/\.(test|spec|it)\.[A-Za-z0-9]+$/.test(basename(t.path)) || /_test\.(go|py|ts|js)$/.test(basename(t.path)))).length;
  let testStyle = 'none';
  if (testEntries.length === 0) testStyle = 'none';
  else if (beside > 0 && inDir > 0) testStyle = 'both';
  else if (beside >= inDir) testStyle = 'beside';
  else testStyle = 'top-level';

  // Single-word names (`index.ts`, `utils.py`) carry no casing information, and
  // SCREAMING_CASE belongs to constants. Consistency is measured over the
  // multi-word names only, where a project actually makes a choice.
  const MULTI_WORD = ['kebab', 'snake', 'camel', 'pascal'];
  const multiWord = Object.entries(naming).filter(([style]) => MULTI_WORD.includes(style));
  const namingTotal = multiWord.reduce((sum, [, n]) => sum + n, 0);
  const overall = Object.entries(naming).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0];
  // Too few multi-word names to judge a convention: report the overall dominant
  // style and treat consistency as satisfied instead of inventing drift.
  const dominant = namingTotal < 8 ? overall : multiWord.sort((a, b) => b[1] - a[1])[0];

  const langLoc = {};
  for (const e of sourceEntries) langLoc[e.lang] = (langLoc[e.lang] ?? 0) + e.lines;
  const primaryLanguage = Object.entries(langLoc).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  let packageManager;
  if (files.includes('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (files.includes('yarn.lock')) packageManager = 'yarn';
  else if (files.includes('bun.lockb') || files.includes('bun.lock')) packageManager = 'bun';
  else if (files.includes('package-lock.json')) packageManager = 'npm';
  else if (files.includes('uv.lock')) packageManager = 'uv';
  else if (files.includes('poetry.lock')) packageManager = 'poetry';
  else if (files.includes('go.mod')) packageManager = 'go';
  else if (files.includes('Cargo.toml')) packageManager = 'cargo';
  else if (files.includes('pyproject.toml')) packageManager = 'pip/pep621';

  const moduleStyle = { esm: 0, cjs: 0 };
  for (const e of sourceEntries) {
    if (e.lang !== 'javascript' && e.lang !== 'typescript') continue;
    if (e.path.endsWith('.mjs') || e.path.endsWith('.mts')) moduleStyle.esm += 1;
    else if (e.path.endsWith('.cjs') || e.path.endsWith('.cts')) moduleStyle.cjs += 1;
  }
  let moduleSystem = manifests.type === 'module' ? 'esm' : (manifests.type === 'commonjs' ? 'commonjs' : 'unspecified');
  if (moduleStyle.esm > 0 && moduleStyle.cjs > 0) moduleSystem = 'mixed-extensions';

  return {
    fileNaming: naming,
    fileNamingByExt: Object.fromEntries([...namingByExt].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    dominantFileNaming: dominant[1] === 0 ? 'none' : dominant[0],
    namingConsistency: namingTotal < 8 ? 1 : round2(dominant[1] / namingTotal),
    namingSampleSize: namingTotal,
    testStyle,
    primaryLanguage,
    packageManager,
    moduleSystem,
    sourceRoots: detectSourceRoots(files),
    hasBarrelFiles: files.some((f) => /(^|\/)index\.(ts|tsx|js|mjs)$/.test(f)),
  };
}

function detectSourceRoots(files) {
  const candidates = ['src', 'lib', 'app', 'apps', 'packages', 'pkg', 'internal', 'cmd', 'api', 'server', 'client', 'web', 'core'];
  return candidates.filter((c) => files.some((f) => f.startsWith(`${c}/`)));
}

export function detectArchetype(files, manifests, topLevel) {
  const hasPackages = files.some((f) => f.startsWith('packages/'));
  const hasApps = files.some((f) => f.startsWith('apps/'));
  const workspaces = (manifests.workspaces ?? []).length > 0 || manifests.packages.length > 1;
  const docHeavy = files.filter((f) => DOC_EXT.has(extname(f).toLowerCase())).length > files.filter((f) => SOURCE_EXT.has(extname(f).toLowerCase())).length;
  const sourceCount = files.filter((f) => SOURCE_EXT.has(extname(f).toLowerCase())).length;

  if (docHeavy && sourceCount < 20) return 'docs-or-list';
  if (hasPackages && hasApps && workspaces) return 'monorepo-apps-packages';
  if (hasPackages && workspaces) return 'monorepo-packages';
  if (hasApps && workspaces) return 'monorepo-apps';
  if (workspaces) return 'monorepo';
  if (sourceCount === 0 && topLevel.length > 0) return 'assets-or-config';
  if (files.some((f) => f.startsWith('src/'))) return 'single-package-src';
  if (files.some((f) => f.startsWith('lib/')) || files.some((f) => f.startsWith('cmd/'))) return 'single-package-flat';
  return 'unknown';
}

/** Derive the module decomposition a reviewer should reason about. */
export function deriveModules(files, entries, adjacency, archetype, manifests) {
  const loc = new Map(entries.map((e) => [e.path, e.loc ?? e.lines]));
  const modules = new Map();

  const add = (name, root, file) => {
    const mod = modules.get(name) ?? { name, root, files: [], fileCount: 0, loc: 0, sourceFiles: 0, testFiles: 0, imports: [], importedBy: [] };
    mod.files.push(file);
    mod.fileCount += 1;
    mod.loc += loc.get(file) ?? 0;
    modules.set(name, mod);
  };

  const isMonorepo = archetype.startsWith('monorepo');
  const nested = (manifests.packages ?? []).map((p) => p.path).filter((p) => p !== '.');

  for (const rel of files) {
    const segments = rel.split('/');
    if (isMonorepo && nested.length > 0) {
      const owner = nested.find((p) => rel === p || rel.startsWith(`${p}/`));
      if (owner) {
        add(owner, owner, rel);
        continue;
      }
    }
    if (segments.length === 1) {
      add('(root)', '.', rel);
      continue;
    }
    if (segments[0] === 'src' && segments.length > 2) {
      add(`src/${segments[1]}`, `src/${segments[1]}`, rel);
      continue;
    }
    if (segments[0] === 'src') {
      add('src/(root)', 'src', rel);
      continue;
    }
    add(segments[0], segments[0], rel);
  }

  const list = [...modules.values()];
  for (const mod of list) {
    mod.files.sort();
    mod.sourceFiles = mod.files.filter((f) => classify(f).kind === 'source').length;
    mod.testFiles = mod.files.filter((f) => classify(f).kind === 'test').length;
    mod.docs = mod.files.filter((f) => classify(f).kind === 'doc').slice(0, 8);
    const moduleSources = mod.files.filter((f) => classify(f).kind === 'source');
    const entryPool = moduleSources.length > 0 ? moduleSources : [];
    mod.entry = entryPool.find((f) => /(^|\/)(index|main|mod|__init__|lib|app)\.[A-Za-z0-9]+$/.test(f) && dirname(f) === mod.root)
      ?? entryPool.find((f) => /(^|\/)(index|main|mod|__init__|lib|app)\.[A-Za-z0-9]+$/.test(f))
      ?? entryPool[0];
    mod.depth = Math.max(0, ...mod.files.map((f) => f.split('/').length - 1));
    mod.directRootFiles = mod.files.filter((f) => dirname(f) === mod.root || (mod.root === '.' && !f.includes('/'))).length;
    mod.longestFile = mod.files
      .map((f) => ({ path: f, lines: loc.get(f) ?? 0 }))
      .sort((a, b) => b.lines - a.lines)[0];
  }
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return list;
}

// ── git facts (optional) ────────────────────────────────────────────────────

async function gitFacts(root, options = {}) {
  const out = { isRepo: false };
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
    out.isRepo = stdout.trim() === 'true';
  } catch {
    return out;
  }
  if (!out.isRepo) return out;
  try {
    const { stdout } = await run('git', ['-C', root, 'log', '-1', '--format=%cI'], { timeout: 5000 });
    out.lastCommitAt = stdout.trim() || undefined;
  } catch { /* ignore */ }
  try {
    const { stdout } = await run('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { timeout: 5000 });
    out.commits = Number.parseInt(stdout.trim(), 10) || undefined;
  } catch { /* ignore */ }
  try {
    const { stdout } = await run('git', ['-C', root, 'log', '--since=90.days', '--name-only', '--pretty=format:'], {
      timeout: 20000, maxBuffer: 64 * 1024 * 1024,
    });
    const counts = new Map();
    for (const line of stdout.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    out.churn90d = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 20)
      .map(([path, commits]) => ({ path, commits }));
    out.churnFiles90d = counts.size;
  } catch { /* ignore */ }
  try {
    const { stdout } = await run('git', ['-C', root, 'status', '--porcelain'], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    // The guard's own state and anything the project declares ignored cannot be
    // "uncommitted work": counting them makes every audit look like a change and
    // makes `digest --check` unstable in CI.
    const exclude = options.exclude;
    const lines = stdout.split('\n').filter(Boolean).filter((line) => {
      const path = line.slice(3).trim().replace(/^"|"$/g, '');
      if (path.startsWith('.structure/')) return false;
      return exclude === undefined ? true : !exclude(path);
    });
    out.dirtyFiles = lines.length;
  } catch { /* ignore */ }
  return out;
}

/** Drop the transient in-memory tables before persisting a snapshot. */
export function toPersisted(snapshot) {
  const copy = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key.startsWith('__')) continue;
    if (value instanceof Map || value instanceof Set) continue;
    copy[key] = value;
  }
  return copy;
}
