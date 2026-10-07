/**
 * Remote GitHub inspection — audit a large open-source project's layout without
 * cloning it.
 *
 * `gh api repos/<owner>/<repo>/git/trees/<ref>?recursive=1` returns every path
 * plus each blob's byte size in one request, which is enough for layout,
 * presence, naming, depth, test-ratio and package-shape judgement. What it
 * cannot give is file content: there is no import graph, no exact line count and
 * no function scan, so this module reports layout facts with estimated LOC and
 * says so, instead of pretending to be a full audit.
 *
 * Used by `guard.mjs remote`, and by `--compare` to diff a local project against
 * a reference repository.
 */
import { execFileSync } from 'node:child_process';

import { sizeClass } from './checks.mjs';
import {
  classifyPath, detectArchetype, detectConventions, detectPresence, namingStyle,
} from './scan.mjs';

// Rough bytes per source line, measured on real files by the corpus research
// (TypeScript 27.5-31.7, Rust 41.8). Only used to size a remote project.
const BYTES_PER_LINE = { rust: 42, go: 32, c: 30, cpp: 30, python: 30, typescript: 30, javascript: 30 };

const REMOTE_IGNORE = new Set(['node_modules', '.git', '.hg', '.svn', 'vendor', 'third_party']);

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return undefined;
    const detail = (error.stderr ?? '').toString().trim() || error.message;
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

/** Repository metadata plus the complete recursive tree of one ref. */
export function fetchRemote(repo, ref) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`expected OWNER/REPO, got "${repo}"`);
  const metaRaw = gh(['api', `repos/${repo}`]);
  const meta = JSON.parse(metaRaw);
  const target = ref ?? meta.default_branch ?? 'HEAD';
  const treeRaw = gh(['api', `repos/${repo}/git/trees/${target}?recursive=1`]);
  const tree = JSON.parse(treeRaw);
  return {
    repo,
    ref: target,
    truncated: tree.truncated === true,
    meta: {
      description: meta.description ?? undefined,
      stars: meta.stargazers_count,
      sizeKb: meta.size,
      language: meta.language,
      license: meta.license?.spdx_id ?? undefined,
      defaultBranch: meta.default_branch,
      pushedAt: meta.pushed_at,
      archived: meta.archived === true,
      topics: meta.topics ?? [],
    },
    entries: tree.tree ?? [],
  };
}

/** Path-only snapshot of a remote repository, in the shape the guard's rules expect. */
export function remoteSnapshot(remote, options = {}) {
  const blobs = remote.entries
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, size: e.size ?? 0 }))
    .filter((e) => !e.path.split('/').some((seg) => REMOTE_IGNORE.has(seg)))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const files = blobs.map((b) => b.path);
  const entries = blobs.map((b) => {
    const { kind, lang } = classifyPath(b.path);
    const per = BYTES_PER_LINE[lang] ?? 32;
    return { path: b.path, kind, lang, bytes: b.size, lines: kind === 'source' || kind === 'test' || kind === 'doc' ? Math.round(b.size / per) : 0 };
  });

  const naming = { kebab: 0, snake: 0, camel: 0, pascal: 0, flat: 0, screaming: 0, other: 0 };
  const namingByExt = new Map();
  for (const e of entries) {
    if (e.kind !== 'source') continue;
    const style = namingStyle(e.path.split('/').pop());
    naming[style] = (naming[style] ?? 0) + 1;
    const ext = (e.path.match(/\.[^./]+$/)?.[0] ?? '(none)').toLowerCase();
    const perExt = namingByExt.get(ext) ?? {};
    perExt[style] = (perExt[style] ?? 0) + 1;
    namingByExt.set(ext, perExt);
  }

  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['Cargo.lock', 'cargo'], ['go.sum', 'go'],
  ];
  const packageManager = lockfiles.find(([name]) => files.includes(name))?.[1];

  const nestedPackageJson = files.filter((f) => f.endsWith('package.json') && f !== 'package.json');
  const nestedCargo = files.filter((f) => f.endsWith('Cargo.toml') && f !== 'Cargo.toml');
  const manifests = {
    packageManager,
    packages: [...nestedPackageJson, ...nestedCargo].map((f) => ({ path: f.replace(/\/(package\.json|Cargo\.toml)$/, ''), name: undefined, deps: undefined })),
    workspaces: files.some((f) => /^pnpm-workspace\.yaml$/.test(f) || /^lerna\.json$/.test(f) || /^nx\.json$/.test(f)) ? ['*'] : [],
    type: undefined,
  };

  const presence = detectPresence(files, manifests);
  const conventions = detectConventions(files, entries, naming, manifests, namingByExt);
  const archetype = detectArchetype(files, manifests, [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))]);

  const depth = files.reduce((max, f) => Math.max(max, f.split('/').length - 1), 0);
  const sourceLoc = entries.filter((e) => e.kind === 'source').reduce((sum, e) => sum + e.lines, 0);

  return {
    remote: { repo: remote.repo, ref: remote.ref, truncated: remote.truncated, estimated: true },
    meta: remote.meta,
    files,
    entries,
    presence,
    archetype,
    conventions,
    metrics: {
      files: files.length,
      sourceFiles: entries.filter((e) => e.kind === 'source').length,
      testFiles: entries.filter((e) => e.kind === 'test').length,
      docFiles: entries.filter((e) => e.kind === 'doc').length,
      sourceLoc,
      estimated: true,
      maxDepth: depth,
      sizeClass: sizeClass({ metrics: { files: files.length } }),
      topLevelEntryCount: new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0])).size,
      rootLooseFiles: files.filter((f) => !f.includes('/')).length,
    },
    options,
  };
}

const PRESENCE_LABELS = [
  ['README', 'readme'],
  ['LICENSE', 'license'],
  ['CHANGELOG', 'changelog'],
  ['CONTRIBUTING', 'contributing'],
  ['SECURITY', 'security'],
  ['CODE_OF_CONDUCT', 'codeOfConduct'],
  ['architecture doc', 'architectureDoc'],
  ['docs/ tree', 'docsDir'],
  ['ADR/RFC dir', 'adrDir'],
  ['CI', 'ci'],
  ['linter', 'linterConfig'],
  ['formatter', 'formatterConfig'],
  ['editorconfig', 'editorconfig'],
  ['type config', 'typeConfig'],
  ['test runner config', 'testConfig'],
  ['lockfile', 'lockfile'],
  ['.gitignore', 'gitignore'],
  ['.gitattributes', 'gitattributes'],
  ['workspace manifest', 'workspaceManifest'],
  ['release automation', 'releaseAutomation'],
  ['agent docs', 'agentDocs'],
  ['examples/', 'examplesDir'],
  ['benchmarks/', 'benchmarks'],
  ['machine-enforced boundaries', '__enforcement'],
];

const LABEL_TO_KEY = new Map(PRESENCE_LABELS.map(([label, key]) => [label, key]));

const presenceValue = (presence, label) => {
  const key = LABEL_TO_KEY.get(label);
  if (key === '__enforcement') return (presence.enforcementArtifacts ?? []).length > 0;
  return key !== undefined && presence[key] === true;
};

/** A local `scan()` result viewed the same way as a remote snapshot, for --compare. */
export function localView(snapshot) {
  return {
    metrics: snapshot.metrics,
    rootLooseFiles: (snapshot.topLevel ?? []).filter((t) => t.type === 'file' || !String(t.path).includes('/')).length,
    has: (label) => presenceValue(snapshot.presence ?? {}, label),
  };
}

/** Human-readable remote layout report, optionally compared with a local scan. */
export function renderRemoteReport(snapshot, local) {
  const { meta, metrics, conventions, presence, archetype, remote } = snapshot;
  const lines = [];
  const push = (line = '') => lines.push(line);

  push(`# ${remote.repo}${remote.ref ? `@${remote.ref}` : ''} — remote layout report`);
  push('');
  if (meta.description) push(`> ${meta.description}`);
  push('');
  push('| Field | Value |');
  push('| --- | --- |');
  push(`| Stars | ${meta.stars ?? '—'} |`);
  push(`| Primary language | ${meta.language ?? 'unknown'} |`);
  push(`| License | ${meta.license ?? 'none declared'} |`);
  push(`| Last push | ${meta.pushedAt ?? '—'}${meta.archived ? ' (ARCHIVED)' : ''} |`);
  push(`| Layout archetype | ${archetype} |`);
  push(`| Files | ${metrics.files} (${metrics.sizeClass} class) |`);
  push(`| Source / test files | ${metrics.sourceFiles} / ${metrics.testFiles} (ratio ${(metrics.testFiles / Math.max(1, metrics.sourceFiles)).toFixed(2)}) |`);
  push(`| Max nesting depth | ${metrics.maxDepth} |`);
  push(`| Root loose files | ${metrics.rootLooseFiles} |`);
  push(`| Top-level entries | ${metrics.topLevelEntryCount} |`);
  push(`| Estimated source LOC | ~${metrics.sourceLoc.toLocaleString('en-US')} |`);
  push(`| Naming | ${conventions.dominantFileNaming} (${Math.round(conventions.namingConsistency * 100)}% of ${conventions.namingSampleSize} multi-word names) |`);
  push(`| Test placement | ${conventions.testStyle} |`);
  push(`| Package manager | ${conventions.packageManager ?? 'unknown'} |`);
  push('');
  if (remote.truncated) {
    push('> **Tree truncated by the API**: counts below are a lower bound. Use `--ref` on a smaller ref or clone shallow for full accuracy.');
    push('');
  }
  push('> LOC and file sizes are **estimated** from blob byte sizes (no clone, no content fetch).');
  push('> Import graph, cycles and function lengths are not available remotely.');
  push('');

  push('## Presence checklist');
  push('');
  push(`| Artifact | ${remote.repo} |${local ? ' local |' : ''}`);
  push(`| --- | --- |${local ? ' --- |' : ''}`);
  for (const [label] of PRESENCE_LABELS) {
    const upstream = presenceValue(presence, label) ? 'yes' : '**missing**';
    push(`| ${label} | ${upstream} |${local ? ` ${local.has(label) ? 'yes' : '**missing**'} |` : ''}`);
  }
  push('');
  const top = new Map();
  for (const e of snapshot.entries) {
    const first = e.path.includes('/') ? e.path.split('/')[0] : '(root)';
    const bucket = top.get(first) ?? { files: 0, source: 0, tests: 0, bytes: 0 };
    bucket.files += 1;
    if (e.kind === 'source') bucket.source += 1;
    if (e.kind === 'test') bucket.tests += 1;
    bucket.bytes += e.bytes;
    top.set(first, bucket);
  }
  push('## Layout');
  push('');
  push('| Top level | Files | Source | Tests | Size |');
  push('| --- | --- | --- | --- | --- |');
  for (const [name, bucket] of [...top.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 24)) {
    push(`| \`${name}\` | ${bucket.files} | ${bucket.source} | ${bucket.tests} | ${(bucket.bytes / 1024).toFixed(0)} KB |`);
  }
  push('');

  const biggest = [...snapshot.entries].filter((e) => e.kind === 'source' || e.kind === 'test')
    .sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  push('## Largest files by bytes (hand-written or not — verify before judging)');
  push('');
  for (const e of biggest) push(`- \`${e.path}\` — ${(e.bytes / 1024).toFixed(0)} KB (~${e.lines} lines estimated)`);
  push('');

  if (local) {
    push('## Compared with the local project');
    push('');
    push('| Metric | Remote | Local | Delta |');
    push('| --- | --- | --- | --- |');
    const rows = [
      ['Files', metrics.files, local.metrics.files],
      ['Max depth', metrics.maxDepth, local.metrics.maxDepth],
      ['Root loose files', metrics.rootLooseFiles, local.rootLooseFiles],
      ['Test / source files', (metrics.testFiles / Math.max(1, metrics.sourceFiles)).toFixed(2), (local.metrics.testFiles / Math.max(1, local.metrics.sourceFiles)).toFixed(2)],
      ['Top-level entries', metrics.topLevelEntryCount, local.metrics.topLevelEntryCount],
    ];
    for (const [label, a, b] of rows) {
      const delta = typeof a === 'number' && typeof b === 'number' ? `${b - a > 0 ? '+' : ''}${b - a}` : '—';
      push(`| ${label} | ${a} | ${b} | ${delta} |`);
    }
    push('');
    const remoteOnly = PRESENCE_LABELS
      .filter(([label]) => presenceValue(presence, label) && !local.has(label))
      .map(([label]) => label);
    if (remoteOnly.length > 0) {
      push(`**Present upstream, missing locally**: ${remoteOnly.join(', ')}.`);
      push('');
      push('Treat these as candidates, not verdicts: a small library legitimately omits some of what a 30k-file monorepo carries.');
      push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
