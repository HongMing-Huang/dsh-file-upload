// Architecture digest generator: turns a snapshot into ARCHITECTURE.md.
//
// Everything between the generated markers is rewritten on every run; the block
// between `<!-- BEGIN CURATED -->` and `<!-- END CURATED -->` is carried over
// verbatim so human intent survives regeneration. Module purposes come from
// `.structure/guard.json` (`describe`), which is the curated half of the map.

import { globToRegExp } from './checks.mjs';

const CURATED_BEGIN = '<!-- BEGIN CURATED -->';
const CURATED_END = '<!-- END CURATED -->';

function sanitize(name) {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function kb(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function extractCurated(existing) {
  if (!existing) return undefined;
  const start = existing.indexOf(CURATED_BEGIN);
  const end = existing.indexOf(CURATED_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  // Return the inner text only: renderDigest re-wraps it in fresh markers, so
  // keeping the old ones would nest a new pair inside them on every run. Any
  // stray marker lines left by an older file are dropped so regeneration heals.
  const inner = existing.slice(start + CURATED_BEGIN.length, end);
  return inner
    .split('\n')
    .filter((line) => line.trim() !== CURATED_BEGIN && line.trim() !== CURATED_END)
    .join('\n')
    .trim();
}

const PRESENCE_LABELS = [
  ['readme', 'README'],
  ['license', 'LICENSE'],
  ['changelog', 'CHANGELOG'],
  ['contributing', 'CONTRIBUTING'],
  ['architectureDoc', 'ARCHITECTURE / DESIGN'],
  ['security', 'SECURITY'],
  ['docsDir', 'docs/ directory'],
  ['adrDir', 'ADR / RFC directory'],
  ['ci', 'CI workflow'],
  ['linterConfig', 'linter config'],
  ['formatterConfig', 'formatter config'],
  ['editorconfig', '.editorconfig'],
  ['typeConfig', 'type config (tsconfig/mypy)'],
  ['testConfig', 'test runner config'],
  ['lockfile', 'lockfile'],
  ['gitignore', '.gitignore'],
  ['gitattributes', '.gitattributes'],
  ['issueTemplates', 'issue templates'],
  ['prTemplate', 'PR template'],
  ['hooksConfig', 'commit hooks / lint-staged'],
  ['releaseAutomation', 'release automation'],
  ['examplesDir', 'examples/'],
  ['benchmarks', 'benchmarks/'],
  ['dockerfile', 'Dockerfile'],
];

/**
 * @param {object} s snapshot (in-memory, with __entries)
 * @param {object} opts { config, findings, baseline, drift, existing, projectName }
 * @returns {string} markdown
 */
export function renderDigest(s, opts = {}) {
  const config = opts.config ?? {};
  const describe = config.describe ?? {};
  const findings = opts.findings ?? [];
  const drift = opts.drift ?? [];
  const baseline = opts.baseline;
  const now = new Date().toISOString().slice(0, 10);

  const out = [];
  out.push(`# ${s.project.name} — Architecture Digest`);
  out.push('');
  out.push(`> Generated ${now} by the \`structure-guard\` skill (\`guard.mjs digest\`).`);
  out.push('> Tables and metrics are regenerated on every run. Text inside the CURATED block, and the');
  out.push('> `describe` map in `.structure/guard.json`, are yours and are never overwritten.');
  out.push('');

  // 1. identity
  out.push('## 1. Identity');
  out.push('');
  out.push(table(['Field', 'Value'], [
    ['Package name', s.project.name],
    ['Version', s.project.version ?? '—'],
    ['Layout archetype', s.project.archetype],
    ['Primary language', s.project.primaryLanguage],
    ['Languages by volume', (s.project.languages ?? []).map((l) => `${l.lang} (${l.loc} LOC)`).join(', ') || '—'],
    ['Module system', s.project.moduleSystem ?? '—'],
    ['Package manager', s.conventions.packageManager ?? '—'],
    ['Engines', s.project.engines ? JSON.stringify(s.project.engines) : '—'],
    ['Runtime deps', s.project.dependencies],
    ['Dev deps', s.project.devDependencies],
    ['Peer deps', s.project.peerDependencies],
    ['Exports map', s.project.exportsMap ? 'yes' : 'no'],
    ['License', s.project.license ?? (s.presence.license ? 'declared in LICENSE file' : '—')],
    ['Repository declared', s.project.repositoryDeclared ? 'yes' : 'no'],
    ['Git', s.git?.isRepo ? `${s.git.commits ?? '?'} commits, last ${s.git.lastCommitAt ?? '?'}${s.git.dirtyFiles ? `, ${s.git.dirtyFiles} dirty files` : ''}` : 'not a repository'],
  ]));
  out.push('');

  // 2. layout
  out.push('## 2. Layout at a glance');
  out.push('');
  out.push(table(['Top level', 'Kind', 'Files', 'LOC', 'Source', 'Tests', 'Purpose (curated)'], s.topLevel
    .filter((t) => t.files > 0)
    .map((t) => [
      `\`${t.path}${t.type === 'dir' ? '/' : ''}\``,
      t.type === 'dir' ? 'directory' : 'file',
      t.files, t.loc, t.sourceFiles, t.testFiles, describe[t.path] ?? '',
    ])));
  out.push('');
  const rootFiles = s.__entries.filter((e) => !e.path.includes('/'));
  out.push(`Root holds ${rootFiles.length} loose file(s): ${rootFiles.map((f) => `\`${f.path}\``).join(', ') || '—'}`);
  out.push('');

  // 3. modules
  out.push('## 3. Modules');
  out.push('');

  // When the project declares modules in .structure/guard.json, the digest shows
  // THAT contract — it is what contributors are held to — and lists whatever the
  // declaration does not cover. Otherwise it falls back to the derived tree view.
  const declared = (config?.modules ?? []).filter((m) => Array.isArray(m.paths) && m.paths.length > 0);
  if (declared.length > 0) {
    const matchers = declared.map((m) => ({ name: m.name, res: m.paths.map((g) => globToRegExp(g)) }));
    const ownerOf = (path) => {
      for (const matcher of matchers) if (matcher.res.some((re) => re.test(path))) return matcher.name;
      return undefined;
    };
    const rows = new Map(declared.map((m) => [m.name, {
      name: m.name, layer: m.layer, files: 0, loc: 0, source: 0, tests: 0,
      entry: undefined, imports: new Set(), importedBy: new Set(),
    }]));
    let undeclared = 0;
    const undeclaredSamples = [];
    for (const e of s.__entries ?? []) {
      if (e.kind !== 'source' && e.kind !== 'test' && e.kind !== 'doc' && e.kind !== 'config') continue;
      const owner = ownerOf(e.path);
      if (owner === undefined) {
        undeclared += 1;
        if (undeclaredSamples.length < 8) undeclaredSamples.push(e.path);
        continue;
      }
      const row = rows.get(owner);
      if (row === undefined) continue;
      row.files += 1;
      row.loc += e.loc ?? 0;
      if (e.kind === 'source') {
        row.source += 1;
        if (row.entry === undefined || /(^|\/)index\.[cm]?[jt]sx?$/.test(e.path)) row.entry = e.path;
      }
      if (e.kind === 'test') row.tests += 1;
    }
    for (const edge of s.__crossEdges ?? []) {
      const from = ownerOf(edge.from);
      const to = ownerOf(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      rows.get(from)?.imports.add(to);
      rows.get(to)?.importedBy.add(from);
    }
    const allowed = new Map((config.boundaries ?? []).map((b) => [b.from, b.mayImport]));
    const live = [...rows.values()].filter((r) => r.files > 0);
    out.push(table(
      ['Module', 'Layer', 'Files', 'LOC', 'Source', 'Tests', 'Entry', 'May import (declared)', 'Actually imports', 'Purpose (curated)'],
      live.map((r) => [
        `\`${r.name}\``,
        r.layer === null || r.layer === undefined ? '—' : r.layer,
        r.files, r.loc, r.source, r.tests,
        r.entry ? `\`${r.entry}\`` : '—',
        allowed.has(r.name) ? (allowed.get(r.name).length > 0 ? allowed.get(r.name).map((x) => `\`${x}\``).join(', ') : '_nothing_') : '_undeclared_',
        r.imports.size > 0 ? [...r.imports].sort().map((x) => `\`${x}\``).join(', ') : '—',
        describe[r.name] ?? (r.entry ? describe[r.entry] : undefined) ?? '',
      ])));
    out.push('');
    if (undeclared > 0) {
      out.push(`_${undeclared} tracked file(s) belong to no declared module: ${undeclaredSamples.map((f) => `\`${f}\``).join(', ')}${undeclared > undeclaredSamples.length ? ', …' : ''}. Either declare them or move them where the contract covers them._`);
      out.push('');
    }
    const edges = [];
    const seen = new Set();
    for (const r of live) {
      for (const to of [...r.imports].sort()) {
        const key = `${r.name}->${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([r.name, to]);
      }
    }
    if (edges.length > 0) {
      out.push('### Declared module graph');
      out.push('');
      out.push('```mermaid');
      out.push('graph LR');
      for (const r of live) out.push(`  ${sanitize(r.name)}["${r.name}${r.layer === null || r.layer === undefined ? '' : ` (L${r.layer})`}"]`);
      for (const [from, to] of edges.slice(0, 60)) out.push(`  ${sanitize(from)} --> ${sanitize(to)}`);
      out.push('```');
      out.push('');
      if (edges.length > 60) {
        out.push(`_Graph truncated at 60 of ${edges.length} declared module edges._`);
        out.push('');
      }
    }
  } else if (s.modules.length === 0) {
    out.push('No modules derived (empty or unrecognized layout).');
  } else {
    out.push(table(['Module', 'Files', 'LOC', 'Source', 'Tests', 'Entry', 'Imports', 'Imported by', 'Purpose (curated)'], s.modules
      .filter((m) => m.fileCount > 0)
      .map((m) => [
        `\`${m.name}\``,
        m.fileCount, m.loc, m.sourceFiles, m.testFiles,
        m.entry ? `\`${m.entry}\`` : '—',
        (m.imports ?? []).length > 0 ? (m.imports ?? []).map((x) => `\`${x}\``).join(', ') : '—',
        (m.importedBy ?? []).length > 0 ? (m.importedBy ?? []).map((x) => `\`${x}\``).join(', ') : '—',
        describe[m.root] ?? describe[m.name] ?? '',
      ])));
    out.push('');

    const edges = [];
    const seen = new Set();
    for (const edge of s.__crossEdges ?? []) {
      const key = `${edge.fromModule}->${edge.toModule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([edge.fromModule, edge.toModule]);
      if (edges.length >= 40) break;
    }
    if (edges.length > 0) {
      out.push('### Module dependency graph');
      out.push('');
      out.push('```mermaid');
      out.push('graph LR');
      for (const mod of s.modules) {
        if (mod.fileCount === 0) continue;
        out.push(`  ${sanitize(mod.name)}["${mod.name}"]`);
      }
      for (const [from, to] of edges) out.push(`  ${sanitize(from)} --> ${sanitize(to)}`);
      out.push('```');
      out.push('');
      if ((s.__crossEdges ?? []).length > edges.length) {
        out.push(`_Graph truncated at ${edges.length} distinct module edges._`);
        out.push('');
      }
    }
  }

  // 4. conventions
  out.push('## 4. Conventions observed');
  out.push('');
  const naming = Object.entries(s.conventions.fileNaming ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  out.push(table(['Aspect', 'Observed'], [
    ['File naming', naming.map(([style, n]) => `${style}: ${n}`).join(', ') || '—'],
    ['Naming consistency', `${Math.round((s.conventions.namingConsistency ?? 0) * 100)}% (dominant: ${s.conventions.dominantFileNaming})`],
    ['Test placement', s.conventions.testStyle],
    ['Test volume', `${s.metrics.testFiles} files / ${s.metrics.testLoc} LOC (ratio ${s.metrics.testToSourceRatio})`],
    ['Source roots', (s.conventions.sourceRoots ?? []).map((r) => `\`${r}/\``).join(', ') || '—'],
    ['Barrel files (index.*)', s.conventions.hasBarrelFiles ? 'present' : 'none'],
    ['Scripts', (s.project.scripts ?? []).map((x) => `\`${x}\``).join(', ') || '—'],
  ]));
  out.push('');

  // 5. health
  out.push('## 5. Structural health');
  out.push('');
  out.push(table(['Metric', 'Value'], [
    ['Files tracked', `${s.metrics.files}${s.truncated ? ' (truncated)' : ''} (${kb(s.metrics.bytes)})`],
    ['Source', `${s.metrics.sourceFiles} files / ${s.metrics.sourceLoc} LOC`],
    ['Tests', `${s.metrics.testFiles} files / ${s.metrics.testLoc} LOC`],
    ['Docs', `${s.metrics.docFiles} files / ${s.metrics.docLoc} LOC`],
    ['Config files', s.metrics.configFiles],
    ['Generated artifacts tracked', s.metrics.generatedFiles],
    ['Vendored files tracked', s.metrics.vendoredFiles],
    ['Max nesting depth', s.metrics.maxDepth],
    ['Average source file', `${s.metrics.avgSourceLines} lines`],
    ['Largest source file', s.largestFiles?.[0] ? `\`${s.largestFiles[0].path}\` (${s.largestFiles[0].lines} lines)` : '—'],
    ['Import graph', `${s.graph.nodes} nodes / ${s.graph.edges} internal edges (${s.graph.crossDirEdges} cross-directory)`],
    ['Import cycles', s.graph.cycles.length],
    ['Unresolved relative imports', s.graph.unresolvedRelative],
    ['Most depended-on files', (s.mostImported ?? []).slice(0, 3).map((m) => `\`${m.path}\` (${m.importedBy})`).join(', ') || '—'],
    ['Churn hotspots (90d)', (s.git?.churn90d ?? []).slice(0, 3).map((c) => `\`${c.path}\` (${c.commits})`).join(', ') || '—'],
  ]));
  out.push('');

  // 6. standards checklist
  out.push('## 6. Standards checklist');
  out.push('');
  out.push(table(['Artifact', 'Status'], PRESENCE_LABELS.map(([key, label]) => [label, s.presence[key] ? 'present' : '**missing**'])));
  out.push('');

  // 7. findings
  if (findings.length > 0 || drift.length > 0) {
    out.push('## 7. Open findings');
    out.push('');
    if (drift.length > 0) {
      out.push(`### Drift since baseline (${baseline?.generatedAt?.slice(0, 10) ?? 'unknown date'})`);
      out.push('');
      for (const f of drift) out.push(`- **${f.severity}** \`${f.ruleId}\` — ${f.message}`);
      out.push('');
    }
    if (findings.length > 0) {
      out.push('### Rule findings');
      out.push('');
      for (const f of findings) out.push(`- **${f.severity}** \`${f.ruleId}\` — ${f.message}`);
      out.push('');
    }
  }

  // 8. curated block
  out.push(CURATED_BEGIN);
  const curated = extractCurated(opts.existing);
  if (curated) {
    out.push(curated);
  } else {
    out.push('## 8. Intent (curated — never regenerated)');
    out.push('');
    out.push('_What this project is for, the boundary rules a contributor must respect, and the_');
    out.push('_reasons behind the layout. Fill this in: it is what turns a structure report into a_');
    out.push('_standard the next change can be judged against._');
    out.push('');
    out.push('### Non-negotiable boundaries');
    out.push('');
    out.push('- ');
    out.push('');
    out.push('### Where new code goes');
    out.push('');
    out.push('- New feature → ');
    out.push('- New shared utility → ');
    out.push('- New external integration → ');
  }
  out.push(CURATED_END);
  out.push('');

  return out.join('\n');
}

export { CURATED_BEGIN, CURATED_END, extractCurated };
