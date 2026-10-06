#!/usr/bin/env node
// structure-guard CLI.
//
//   node guard.mjs <command> [dir] [options]
//
// Commands
//   scan       print the structure snapshot (JSON) or a human summary
//   init       create .structure/guard.json, a baseline, and ARCHITECTURE.md
//   audit      run the rule set plus baseline drift diff, write last-audit.json
//   diff       drift only, against .structure/baseline.json
//   digest     (re)generate ARCHITECTURE.md, preserving the curated block
//   baseline   write or refresh .structure/baseline.json
//   hook       install|remove a git pre-commit hook that gates on audit
//   doctor     verify this installation (rules, checks, node version)
//
// Exit codes: 0 clean, 1 findings at or above the failure severity, 2 usage/IO error.

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan as scanProject, toPersisted, SNAPSHOT_VERSION } from './lib/scan.mjs';
import { CHECKS, diffSnapshots, runRules, summarize } from './lib/checks.mjs';
import { renderDigest } from './lib/digest.mjs';
import { fetchRemote, localView, remoteSnapshot, renderRemoteReport } from './lib/remote.mjs';
import { renderAgents } from './lib/agents.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = dirname(HERE);
const DEFAULT_RULES = join(SKILL_ROOT, 'references', 'rules.json');
const STRUCTURE_DIR = '.structure';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: color ? '\x1b[0m' : '',
  bold: color ? '\x1b[1m' : '',
  dim: color ? '\x1b[2m' : '',
  red: color ? '\x1b[31m' : '',
  yellow: color ? '\x1b[33m' : '',
  blue: color ? '\x1b[36m' : '',
  green: color ? '\x1b[32m' : '',
};

const USAGE = `structure-guard — keep a project's structure inside its declared standard

Usage: node guard.mjs <command> [dir] [options]

Commands:
  scan [dir]                 Structure snapshot. --json for raw, default is a summary.
  init [dir]                 Create .structure/guard.json + baseline + ARCHITECTURE.md.
  audit [dir]                Rules + drift. --strict fails on warn, --no-fail never fails.
  diff [dir]                 Drift against .structure/baseline.json only.
  digest [dir]               Regenerate ARCHITECTURE.md (curated block preserved).
  baseline [dir]             Write .structure/baseline.json from the current tree.
  hook install|remove [dir]  Manage a git pre-commit gate (errors block;
                             add --strict to also block on warnings).
  watch [dir]                Re-audit on an interval; report only on change.
                             --interval <sec> (default 60), --max-minutes <n>
  remote <owner/repo>        Layout report for a GitHub project, no clone (gh CLI).
                             --ref <ref>, --compare <dir>, --json, --out <file>
  ci install|remove [dir]    Vendor the engine + write a CI workflow (GitHub Actions).
                             remove --purge deletes the vendored copy too.
  agents [dir]               Write AGENTS.md from the declared contract (--check, --force).
  verify [dir]               Structure gate + package scripts (typecheck, test, build).
                             --only a,b, --timeout <sec>, --no-audit, --json
  doctor                     Verify rules.json, checks and the Node version.

Options:
  --json                 machine-readable output
  --md                   markdown output (audit)
  --out <file>           write the primary artifact to a file
  --rules <file>         rule set to use instead of references/rules.json
  --ignore <glob>        extra ignore glob (repeatable)
  --no-graph             skip import extraction (faster on huge trees)
  --no-git               skip git facts
  --no-drift             audit without baseline comparison
  --update-baseline      accept the current tree as the new baseline after auditing
  --interval <sec>       watch polling interval (default 60)
  --max-minutes <n>      stop watch after n minutes (default: run until killed)
  --strict / --no-fail   failure threshold for audit
  --force                overwrite existing files (init, hook)
  --quiet                only the summary line
`;

function fail(message, code = 2) {
  process.stderr.write(`${c.red}error:${c.reset} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key.startsWith('no-')) { flags[key] = true; continue; }
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    if (key === 'ignore') {
      flags.ignore = [...(flags.ignore ?? []), next];
      i += 1;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { positional, flags };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    fail(`cannot read ${path}: ${error.message}`);
  }
  return undefined;
}

function projectDir(positional, flags) {
  const raw = positional.find((p) => !['install', 'remove'].includes(p)) ?? '.';
  const dir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(dir)) fail(`no such directory: ${dir}`);
  return dir;
}

async function loadConfig(dir) {
  const path = join(dir, STRUCTURE_DIR, 'guard.json');
  const raw = await readJson(path);
  if (raw === undefined) return { config: {}, path, exists: false };
  const config = { ...raw };
  // First match wins when a file is attributed to a module, so the most
  // specific glob must be consulted first regardless of how the file is ordered.
  if (Array.isArray(config.modules)) {
    config.modules = [...config.modules].sort((a, b) => globSpecificity(b.paths) - globSpecificity(a.paths));
  }
  return { config, path, exists: true };
}

function globSpecificity(patterns) {
  let best = 0;
  for (const pattern of patterns ?? []) {
    const literal = String(pattern).split('*')[0];
    if (literal.length > best) best = literal.length;
  }
  return best;
}

async function loadRules(flags, config) {
  const path = flags.rules ? resolve(process.cwd(), flags.rules) : DEFAULT_RULES;
  const doc = await readJson(path);
  if (!doc) fail(`rule set not found: ${path}`);
  const disabled = new Set(config.rules?.disabled ?? []);
  const overrides = config.rules?.overrides ?? {};
  const rules = [];
  for (const rule of doc.rules ?? []) {
    if (disabled.has(rule.id)) continue;
    const override = overrides[rule.id];
    rules.push(override
      ? { ...rule, ...override, params: { ...(rule.params ?? {}), ...(override.params ?? {}) } }
      : rule);
  }
  return { rules, path };
}

async function snapshot(dir, flags, config) {
  return scanProject(dir, {
    ignore: [...(config.ignore ?? []), ...(flags.ignore ?? [])],
    graph: flags['no-graph'] !== true,
    git: flags['no-git'] !== true,
    useGit: true,
  });
}

async function readBaseline(dir) {
  const path = join(dir, STRUCTURE_DIR, 'baseline.json');
  const baseline = await readJson(path);
  if (!baseline) return { baseline: undefined, path };
  let ageDays;
  if (baseline.generatedAt) ageDays = (Date.now() - Date.parse(baseline.generatedAt)) / 86400000;
  return { baseline, path, ageDays };
}

function score(summary) {
  return Math.max(0, Math.min(100, 100 - summary.error * 8 - summary.warn * 3 - summary.info));
}

// ── rendering ───────────────────────────────────────────────────────────────

function severityColor(severity) {
  if (severity === 'error') return c.red;
  if (severity === 'warn') return c.yellow;
  return c.blue;
}

function renderText(s, findings, drift, meta) {
  const sum = summarize([...findings, ...drift]);
  const out = [];
  out.push(`${c.bold}structure-guard${c.reset} — ${s.project.name} ${s.project.version ?? ''}`.trim());
  out.push(`${c.dim}archetype${c.reset} ${s.project.archetype}  ${c.dim}language${c.reset} ${s.project.primaryLanguage}  ${c.dim}files${c.reset} ${s.metrics.files}  ${c.dim}source LOC${c.reset} ${s.metrics.sourceLoc}  ${c.dim}test ratio${c.reset} ${s.metrics.testToSourceRatio}  ${c.dim}depth${c.reset} ${s.metrics.maxDepth}  ${c.dim}cycles${c.reset} ${s.graph.cycles.length}`);
  out.push(`${c.bold}score ${score(sum)}/100${c.reset}  ${severityColor('error')}${sum.error} error${c.reset}  ${severityColor('warn')}${sum.warn} warn${c.reset}  ${severityColor('info')}${sum.info} info${c.reset}   ${c.dim}(${meta.scanMs}ms scan, ${meta.rulesPath.split('/').pop()})${c.reset}`);
  out.push('');

  const sections = [
    ['DRIFT since baseline', drift],
    ['FINDINGS', findings],
  ];
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    out.push(`${c.bold}${title}${c.reset}`);
    let lastSeverity;
    for (const item of items) {
      if (item.severity !== lastSeverity) {
        out.push(`${severityColor(item.severity)}${item.severity.toUpperCase()}${c.reset}`);
        lastSeverity = item.severity;
      }
      out.push(`  ${c.bold}${item.ruleId}${c.reset} — ${item.message}`);
      for (const line of (item.evidence ?? []).slice(0, 5)) out.push(`      ${c.dim}${line}${c.reset}`);
      if ((item.evidence ?? []).length > 5) out.push(`      ${c.dim}… +${item.evidence.length - 5} more${c.reset}`);
      if (item.suggestion) out.push(`      ${c.green}→${c.reset} ${item.suggestion}`);
      if (item.standard && item.standard.length > 0) out.push(`      ${c.dim}standard: ${item.standard.join(', ')}${c.reset}`);
    }
    out.push('');
  }
  if (sum.total === 0) out.push(`${c.green}No structural findings. The tree matches its declared standard.${c.reset}\n`);
  return out.join('\n');
}

function renderMarkdown(s, findings, drift, meta) {
  const sum = summarize([...findings, ...drift]);
  const out = [];
  out.push(`# structure-guard report — ${s.project.name}`);
  out.push('');
  out.push(`- archetype: \`${s.project.archetype}\` · language: \`${s.project.primaryLanguage}\` · files: ${s.metrics.files} · source LOC: ${s.metrics.sourceLoc}`);
  out.push(`- score: **${score(sum)}/100** · ${sum.error} error · ${sum.warn} warn · ${sum.info} info`);
  out.push(`- rules: \`${meta.rulesPath}\`${meta.baseline ? ` · baseline: \`${meta.baseline.generatedAt}\`` : ' · baseline: none'}`);
  out.push('');
  for (const [title, items] of [['Drift since baseline', drift], ['Findings', findings]]) {
    if (items.length === 0) continue;
    out.push(`## ${title}`);
    out.push('');
    for (const item of items) {
      out.push(`### \`${item.ruleId}\` — ${item.severity}`);
      out.push('');
      out.push(item.message);
      if ((item.evidence ?? []).length > 0) {
        out.push('');
        for (const line of item.evidence.slice(0, 8)) out.push(`- \`${line}\``);
      }
      if (item.suggestion) {
        out.push('');
        out.push(`> ${item.suggestion}`);
      }
      out.push('');
    }
  }
  if (sum.total === 0) {
    out.push('No structural findings.');
    out.push('');
  }
  return out.join('\n');
}

function renderSummaryLine(s, findings, drift) {
  const sum = summarize([...findings, ...drift]);
  return `structure-guard ${s.project.name}: score ${score(sum)}/100 — ${sum.error} error, ${sum.warn} warn, ${sum.info} info`;
}

function renderScanSummary(s) {
  const out = [];
  out.push(`${c.bold}${s.project.name}${c.reset} ${s.project.version ?? ''} — ${s.project.archetype}`);
  out.push(`${c.dim}languages${c.reset} ${(s.project.languages ?? []).map((l) => `${l.lang}:${l.loc}`).join(' ')}`);
  out.push(`${c.dim}files${c.reset} ${s.metrics.files} (${s.metrics.sourceFiles} source, ${s.metrics.testFiles} test, ${s.metrics.docFiles} doc, ${s.metrics.configFiles} config)`);
  out.push(`${c.dim}volume${c.reset} ${s.metrics.sourceLoc} source LOC, ${s.metrics.testLoc} test LOC, avg file ${s.metrics.avgSourceLines} lines, max depth ${s.metrics.maxDepth}`);
  out.push(`${c.dim}graph${c.reset} ${s.graph.nodes} nodes, ${s.graph.edges} internal edges, ${s.graph.cycles.length} cycles, ${s.graph.unresolvedRelative} unresolved`);
  out.push(`${c.dim}conventions${c.reset} naming ${s.conventions.dominantFileNaming} (${Math.round(s.conventions.namingConsistency * 100)}%), tests ${s.conventions.testStyle}, modules ${s.project.moduleSystem}, manager ${s.conventions.packageManager ?? '—'}`);
  out.push('');
  out.push(`${c.bold}top level${c.reset}`);
  for (const t of s.topLevel) out.push(`  ${t.path.padEnd(24)} ${String(t.files).padStart(5)} files ${String(t.loc).padStart(8)} LOC ${String(t.sourceFiles).padStart(5)} src ${String(t.testFiles).padStart(4)} test`);
  out.push('');
  out.push(`${c.bold}modules${c.reset}`);
  for (const m of s.modules) {
    out.push(`  ${m.name.padEnd(28)} ${String(m.fileCount).padStart(4)} files ${String(m.loc).padStart(7)} LOC  in:${(m.importedBy ?? []).join(',') || '-'}  out:${(m.imports ?? []).join(',') || '-'}`);
  }
  out.push('');
  out.push(`${c.bold}largest files${c.reset}`);
  for (const f of s.largestFiles.slice(0, 10)) out.push(`  ${String(f.lines).padStart(6)}  ${f.path}`);
  if ((s.git?.churn90d ?? []).length > 0) {
    out.push('');
    out.push(`${c.bold}churn (90d)${c.reset}`);
    for (const f of s.git.churn90d.slice(0, 10)) out.push(`  ${String(f.commits).padStart(4)}x  ${f.path}`);
  }
  return out.join('\n');
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdScan(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config } = await loadConfig(dir);
  const s = await snapshot(dir, flags, config);
  const body = flags.json ? JSON.stringify(toPersisted(s), null, 2) : renderScanSummary(s);
  if (flags.out) {
    await mkdir(dirname(resolve(flags.out)), { recursive: true });
    await writeFile(resolve(flags.out), body);
    process.stdout.write(`wrote ${resolve(flags.out)}\n`);
  } else {
    process.stdout.write(`${body}\n`);
  }
  return 0;
}

async function cmdBaseline(dir, flags, config, s) {
  const path = join(dir, STRUCTURE_DIR, 'baseline.json');
  await mkdir(dirname(path), { recursive: true });
  const persisted = toPersisted(s ?? await snapshot(dir, flags, config));
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);
  return path;
}

async function cmdInit(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config, exists } = await loadConfig(dir);
  if (exists && !flags.force) fail(`${join(dir, STRUCTURE_DIR, 'guard.json')} already exists (use --force to overwrite)`);
  const s = await snapshot(dir, flags, config);

  const roots = s.modules
    .filter((m) => m.name !== '(root)' && m.sourceFiles > 0)
    .map((m) => m.root)
    .filter((root) => root !== '.');
  // Drop catch-all roots that merely contain another module: declaring them
  // would swallow every file under a more specific module.
  const specificRoots = roots.filter((root) => !roots.some((other) => other !== root && other.startsWith(`${root}/`)));
  const starterModules = specificRoots
    .slice(0, 30)
    .map((root) => ({
      name: root.replace(/\//g, '-'),
      paths: [`${root}/**`],
      layer: null,
    }));

  const doc = {
    version: 1,
    $comment: 'Project structure contract for the structure-guard skill. `modules` + `boundaries` are the declared standard; `audit` reports every violation. Edit deliberately, then run `guard.mjs baseline` to accept the new shape.',
    archetype: flags.archetype ?? s.project.archetype,
    ignore: ['**/*.min.js', '**/*.map'],
    modules: starterModules,
    boundaries: [],
    thresholds: {
      maxFileLines: 600,
      fileGrowthWarn: 0.4,
      locGrowthWarn: 0.6,
      testRatioDropWarn: 0.75,
      largestFileGrowthWarn: 1.5,
      dependencyJumpWarn: 8,
      newTopLevelSeverity: 'warn',
    },
    rules: { disabled: [], overrides: {} },
    // Optional declarative casing rules, ls-lint style. Inactive while null.
    // Example: { "files": { "*.ts": "kebab", "*.tsx": "pascal" }, "directories": { "packages/**": "kebab" } }
    naming: null,
    describe: Object.fromEntries(s.modules.filter((m) => m.fileCount > 0).slice(0, 30).map((m) => [m.root, ''])),
    digest: { path: 'ARCHITECTURE.md' },
    todo: [
      'Give each module a one-line purpose in `describe`.',
      'Declare `boundaries`: which module may import which. Without them, boundary rules stay silent.',
      'Set `layer` per module (0 = innermost) to enable layer-violation checks.',
      'Optionally declare `naming` to enforce casing per file glob (rolldown does this in .ls-lint.json).',
      'Run `guard.mjs digest` then curate the CURATED block of ARCHITECTURE.md.',
      'Run `guard.mjs baseline` once the shape is agreed, then `guard.mjs hook install`.',
    ],
  };

  const configPath = join(dir, STRUCTURE_DIR, 'guard.json');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${c.green}wrote${c.reset} ${STRUCTURE_DIR}/guard.json\n`);

  // Digest before baseline, so the baseline already contains the artifacts this
  // command created and the first audit does not report them as drift.
  const digestPath = join(dir, doc.digest.path);
  const existingDigest = existsSync(digestPath) ? await readFile(digestPath, 'utf8') : undefined;
  if (existingDigest && !flags.force) {
    process.stdout.write(`${c.yellow}kept${c.reset} existing ${doc.digest.path} (use --force to regenerate)\n`);
  } else {
    const md = renderDigest(s, { config: doc, findings: [], drift: [], existing: existingDigest });
    await writeFile(digestPath, md);
    process.stdout.write(`${c.green}wrote${c.reset} ${doc.digest.path}\n`);
  }

  const baselinePath = await cmdBaseline(dir, flags, doc);
  process.stdout.write(`${c.green}wrote${c.reset} ${STRUCTURE_DIR}/baseline.json\n`);
  process.stdout.write(`\nNext: declare module boundaries in ${STRUCTURE_DIR}/guard.json, then run \`guard.mjs audit\`.\n`);
  return 0;
}

async function auditOnce(dir, flags) {
  const { config } = await loadConfig(dir);
  const { rules, path: rulesPath } = await loadRules(flags, config);
  const s = await snapshot(dir, flags, config);
  const { baseline, path: baselinePath, ageDays } = await readBaseline(dir);

  const context = {
    config,
    dir,
    rootPackage: s.__rootPackage,
    fileSet: s.__fileSet,
    hasBaseline: Boolean(baseline),
    baselineAgeDays: ageDays,
    baselinePath,
  };
  const findings = runRules(s, rules, context);
  const drift = (baseline && flags['no-drift'] !== true)
    ? diffSnapshots(baseline, toPersisted(s), config)
    : [];

  return { config, rulesPath, snapshot: s, findings, drift, baseline, baselinePath, context };
}

async function cmdAudit(positional, flags) {
  const dir = projectDir(positional, flags);
  const result = await auditOnce(dir, flags);
  const { snapshot: s, findings, drift, baseline, rulesPath } = result;
  const sum = summarize([...findings, ...drift]);
  const meta = { scanMs: s.scanMs, rulesPath, baseline };

  if (flags.json) {
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      project: s.project.name,
      root: dir,
      score: score(sum),
      summary: sum,
      metrics: s.metrics,
      rulesPath,
      baseline: baseline ? { generatedAt: baseline.generatedAt, files: baseline.metrics?.files } : null,
      drift,
      findings,
    }, null, 2);
    if (flags.out) await writeFile(resolve(flags.out), `${body}\n`);
    else process.stdout.write(`${body}\n`);
  } else if (flags.md) {
    const body = renderMarkdown(s, findings, drift, meta);
    if (flags.out) await writeFile(resolve(flags.out), body);
    else process.stdout.write(`${body}\n`);
  } else if (flags.quiet) {
    process.stdout.write(`${renderSummaryLine(s, findings, drift)}\n`);
  } else {
    process.stdout.write(`${renderText(s, findings, drift, meta)}\n`);
  }

  // Always persist the machine-readable result so later runs, hooks and agents
  // can read the last verdict without re-scanning.
  const lastPath = join(dir, STRUCTURE_DIR, 'last-audit.json');
  await mkdir(dirname(lastPath), { recursive: true });
  await writeFile(lastPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    score: score(sum),
    summary: sum,
    baseline: baseline ? baseline.generatedAt : null,
    drift,
    findings,
  }, null, 2)}\n`);

  if (flags['update-baseline'] === true) {
    const path = await cmdBaseline(dir, flags, result.config, s);
    process.stdout.write(`${c.green}baseline updated${c.reset} ${path}\n`);
  }

  if (flags['no-fail'] === true) return 0;
  if (flags.strict === true) return sum.error + sum.warn > 0 ? 1 : 0;
  return sum.error > 0 ? 1 : 0;
}

async function cmdDiff(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config } = await loadConfig(dir);
  const { baseline, path: baselinePath } = await readBaseline(dir);
  if (!baseline) fail(`no baseline at ${baselinePath} — run \`guard.mjs baseline ${dir}\``);
  const s = await snapshot(dir, flags, config);
  const drift = diffSnapshots(baseline, toPersisted(s), config);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ baseline: baseline.generatedAt, drift }, null, 2)}\n`);
  } else if (drift.length === 0) {
    process.stdout.write(`${c.green}no drift${c.reset} since ${baseline.generatedAt}\n`);
  } else {
    process.stdout.write(`${c.bold}drift since ${baseline.generatedAt}${c.reset}\n`);
    for (const item of drift) {
      process.stdout.write(`  ${severityColor(item.severity)}${item.severity.toUpperCase()}${c.reset} ${c.bold}${item.ruleId}${c.reset} — ${item.message}\n`);
      for (const line of (item.evidence ?? []).slice(0, 5)) process.stdout.write(`      ${c.dim}${line}${c.reset}\n`);
      if (item.suggestion) process.stdout.write(`      ${c.green}→${c.reset} ${item.suggestion}\n`);
    }
    process.stdout.write('');
  }
  return drift.some((d) => d.severity === 'error') ? 1 : 0;
}

async function cmdDigest(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config } = await loadConfig(dir);
  const s = await snapshot(dir, flags, config);
  const digestRel = config.digest?.path ?? 'ARCHITECTURE.md';
  const outPath = flags.out ? resolve(flags.out) : join(dir, digestRel);
  const existing = existsSync(outPath) ? await readFile(outPath, 'utf8') : undefined;

  let findings = [];
  let drift = [];
  let baseline;
  if (flags['no-audit'] !== true) {
    const result = await auditOnce(dir, flags);
    findings = result.findings;
    drift = result.drift;
    baseline = result.baseline;
  }
  const md = renderDigest(s, { config, findings, drift, baseline, existing });
  if (flags.check === true) {
    process.stdout.write(existing === md ? 'digest up to date\n' : 'digest stale — regenerate\n');
    return existing === md ? 0 : 1;
  }
  await writeFile(outPath, md);
  process.stdout.write(`${c.green}wrote${c.reset} ${outPath} (${md.split('\n').length} lines)\n`);
  return 0;
}

async function cmdHook(positional, flags) {
  const action = positional[0];
  const dir = projectDir(positional.slice(1), flags);
  const gitDir = join(dir, '.git');
  if (!existsSync(gitDir)) fail(`${dir} is not a git repository`);
  const hookPath = join(gitDir, 'hooks', 'pre-commit');
  const BEGIN = '# structure-guard:begin';
  const END = '# structure-guard:end';
  const block = [
    BEGIN,
    // Errors block a commit; warnings do not, unless `--strict` was asked for.
    // A gate that fails on advice gets bypassed, and then it gates nothing.
    `node "${join(HERE, 'guard.mjs')}" audit "${dir}" ${flags.strict === true ? '--strict ' : ''}--quiet || {`,
    `  echo "structure-guard: commit blocked by structural findings (bypass once with git commit --no-verify)"; exit 1; }`,
    END,
  ].join('\n');

  const strip = (body) => {
    const startAt = body.indexOf(BEGIN);
    if (startAt === -1) return body;
    const endAt = body.indexOf(END, startAt);
    if (endAt === -1) return body;
    return `${body.slice(0, startAt)}${body.slice(endAt + END.length)}`.replace(/\n{3,}/g, '\n\n').trim();
  };

  if (action === 'remove') {
    if (!existsSync(hookPath)) { process.stdout.write('no pre-commit hook installed\n'); return 0; }
    const body = await readFile(hookPath, 'utf8');
    if (!body.includes(BEGIN)) fail('the existing pre-commit hook was not installed by structure-guard; refusing to modify it');
    const rest = strip(body);
    if (rest.replace(/#!/g, '').trim() === '' || rest.trim() === '#!/bin/sh') {
      await writeFile(hookPath, '');
      process.stdout.write(`removed ${hookPath} (nothing else was in it)\n`);
      return 0;
    }
    await writeFile(hookPath, `${rest}\n`);
    process.stdout.write('removed the structure-guard block from .git/hooks/pre-commit\n');
    return 0;
  }
  if (action !== 'install') fail('hook expects `install` or `remove`');

  if (existsSync(hookPath)) {
    const body = await readFile(hookPath, 'utf8');
    if (body.includes(BEGIN)) {
      await writeFile(hookPath, `${strip(body)}\n\n${block}\n`);
      process.stdout.write('updated the structure-guard block in .git/hooks/pre-commit\n');
      return 0;
    }
    if (!flags.force) fail(`a pre-commit hook already exists at ${hookPath}; re-run with --force to append the structure-guard block`);
    await writeFile(hookPath, `${body.trimEnd()}\n\n${block}\n`);
    process.stdout.write('appended the structure-guard block to the existing hook\n');
    return 0;
  }
  await writeFile(hookPath, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
  process.stdout.write(`${c.green}installed${c.reset} ${hookPath}\n`);
  return 0;
}

async function cmdWatch(positional, flags) {
  const dir = projectDir(positional, flags);
  const seconds = Number.parseInt(flags.interval ?? '60', 10);
  const intervalMs = Number.isFinite(seconds) && seconds >= 5 ? seconds * 1000 : 60000;
  const maxMinutes = Number.parseInt(flags['max-minutes'] ?? '0', 10) || 0;
  const logPath = join(dir, STRUCTURE_DIR, 'watch.log');
  await mkdir(dirname(logPath), { recursive: true });

  process.stdout.write(`structure-guard watch ${dir}\n  interval ${intervalMs / 1000}s${maxMinutes ? `, stop after ${maxMinutes}m` : ''}, log ${logPath}\n`);

  let previous;
  let ticks = 0;
  let changes = 0;

  const stateOf = (result) => {
    const all = [...result.findings, ...result.drift];
    const sum = summarize(all);
    return {
      at: new Date().toISOString(),
      score: score(sum),
      summary: sum,
      files: result.snapshot.metrics.files,
      sourceLoc: result.snapshot.metrics.sourceLoc,
      maxDepth: result.snapshot.metrics.maxDepth,
      cycles: result.snapshot.graph.cycles.length,
      modules: result.snapshot.modules.map((m) => m.name).join(','),
      topLevel: result.snapshot.topLevel.filter((t) => t.type === 'dir').map((t) => t.path).join(','),
      errors: all.filter((f) => f.severity === 'error').map((f) => f.ruleId).sort().join(','),
      driftRules: result.drift.map((f) => f.ruleId).sort().join(','),
      findings: all,
      drift: result.drift,
      result,
    };
  };

  const report = (state, changed) => {
    const line = `${state.at} score=${state.score} files=${state.files} loc=${state.sourceLoc} depth=${state.maxDepth} cycles=${state.cycles} errors=${state.summary.error} warn=${state.summary.warn} info=${state.summary.info}${changed ? ' CHANGED' : ''}`;
    process.stdout.write(`${line}\n`);
    if (changed) {
      for (const item of state.result.drift) {
        process.stdout.write(`  ${severityColor(item.severity)}${item.severity.toUpperCase()}${c.reset} ${item.ruleId} — ${item.message}\n`);
      }
      for (const item of state.result.findings.filter((f) => f.severity === 'error')) {
        process.stdout.write(`  ${c.red}ERROR${c.reset} ${item.ruleId} — ${item.message}\n`);
      }
    }
    return `${JSON.stringify({
      at: state.at, score: state.score, files: state.files, sourceLoc: state.sourceLoc,
      maxDepth: state.maxDepth, cycles: state.cycles, summary: state.summary,
      changed, drift: state.drift.map((d) => d.ruleId), errors: state.errors ? state.errors.split(',') : [],
    })}\n`;
  };

  const tick = async () => {
    ticks += 1;
    try {
      const state = stateOf(await auditOnce(dir, { ...flags, quiet: true }));
      const changed = previous !== undefined && (
        previous.score !== state.score
        || previous.files !== state.files
        || previous.modules !== state.modules
        || previous.topLevel !== state.topLevel
        || previous.errors !== state.errors
        || previous.cycles !== state.cycles
      );
      if (changed) changes += 1;
      if (previous === undefined || changed) {
        const line = report(state, changed);
        const { appendFile } = await import('node:fs/promises');
        await appendFile(logPath, line);
        if (changed) {
          // Keep the machine-readable verdict fresh only on real change, so a
          // long watch does not churn the file every interval.
          const lastPath = join(dir, STRUCTURE_DIR, 'last-audit.json');
          await writeFile(lastPath, `${JSON.stringify({
            generatedAt: state.at, score: state.score, summary: state.summary,
            drift: state.result.drift, findings: state.result.findings,
          }, null, 2)}\n`);
        }
      }
      previous = state;
    } catch (error) {
      process.stdout.write(`${c.red}watch tick failed:${c.reset} ${error.message}\n`);
    }
  };

  await tick();
  const stop = new Promise((resolveStop) => {
    const finish = (reason) => { clearInterval(timer); resolveStop(reason); };
    const timer = setInterval(() => { void tick(); }, intervalMs);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish(signal));
    if (maxMinutes > 0) setTimeout(() => finish('max-minutes'), maxMinutes * 60000).unref?.();
  });
  const reason = await stop;
  process.stdout.write(`\nstructure-guard watch stopped (${reason}): ${ticks} tick(s), ${changes} structural change(s). Log: ${logPath}\n`);
  return 0;
}

async function cmdRemote(positional, flags) {
  const repo = positional[0];
  if (!repo) fail('usage: guard.mjs remote <owner/repo> [--ref <ref>] [--compare <dir>] [--json]');
  let remote;
  try {
    remote = fetchRemote(repo, flags.ref);
  } catch (error) {
    fail(error.message);
  }
  const snapshot = remoteSnapshot(remote);

  if (flags.json === true) {
    const payload = {
      repo: snapshot.remote.repo,
      ref: snapshot.remote.ref,
      truncated: snapshot.remote.truncated,
      estimated: true,
      meta: snapshot.meta,
      archetype: snapshot.archetype,
      metrics: snapshot.metrics,
      conventions: {
        dominantFileNaming: snapshot.conventions.dominantFileNaming,
        namingConsistency: snapshot.conventions.namingConsistency,
        namingSampleSize: snapshot.conventions.namingSampleSize,
        testStyle: snapshot.conventions.testStyle,
        packageManager: snapshot.conventions.packageManager ?? null,
      },
      presence: snapshot.presence,
      topLevel: [...new Set(snapshot.files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))]
        .map((name) => {
          const memberEntries = snapshot.entries.filter((e) => e.path.startsWith(`${name}/`));
          return {
            name,
            files: memberEntries.length,
            source: memberEntries.filter((e) => e.kind === 'source').length,
            tests: memberEntries.filter((e) => e.kind === 'test').length,
            bytes: memberEntries.reduce((sum, e) => sum + e.bytes, 0),
          };
        })
        .sort((a, b) => b.files - a.files),
      largest: [...snapshot.entries].sort((a, b) => b.bytes - a.bytes).slice(0, 15)
        .map((e) => ({ path: e.path, bytes: e.bytes, estimatedLines: e.lines, kind: e.kind })),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (flags.out) await writeFile(resolve(flags.out), text);
    else process.stdout.write(text);
    return 0;
  }

  let local;
  if (flags.compare !== undefined) {
    const dir = flags.compare === '' ? process.cwd() : resolve(String(flags.compare));
    local = localView(await scanProject(dir, { graph: false }));
  }
  const md = renderRemoteReport(snapshot, local);
  if (flags.out) {
    await writeFile(resolve(flags.out), md);
    process.stdout.write(`wrote ${resolve(flags.out)}\n`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

const CI_MARKER = '# structure-guard: managed workflow';

async function cmdCi(positional, flags) {
  const action = positional[0] ?? 'install';
  const dir = projectDir(positional.slice(1), flags);
  // Mirrors the skill's own layout (`scripts/` beside `references/`) so every
  // relative path inside the engine keeps working in the vendored copy.
  const relativeVendor = join('.dsh', 'structure-guard');
  const relativeEntry = join(relativeVendor, 'scripts', 'guard.mjs');
  const vendorDir = join(dir, relativeVendor);
  const workflowRel = join('.github', 'workflows', 'structure-guard.yml');
  const workflowPath = join(dir, workflowRel);

  if (action === 'remove') {
    let removed = 0;
    if (existsSync(workflowPath)) {
      const body = await readFile(workflowPath, 'utf8');
      if (!body.startsWith(CI_MARKER)) fail(`${workflowRel} was not written by structure-guard; refusing to delete it`);
      await rm(workflowPath, { force: true });
      removed += 1;
    }
    if (flags.purge === true && existsSync(vendorDir)) {
      await rm(vendorDir, { recursive: true, force: true });
      removed += 1;
    }
    process.stdout.write(removed > 0 ? `removed ${removed} CI artifact(s)\n` : 'nothing to remove\n');
    return 0;
  }

  if (action !== 'install') fail(`unknown ci action: ${action}`);

  if (existsSync(workflowPath) && flags.force !== true) {
    const body = await readFile(workflowPath, 'utf8');
    if (!body.startsWith(CI_MARKER)) fail(`${workflowRel} exists and is not ours; pass --force to overwrite`);
  }

  // Vendor the engine so the gate is reproducible on a runner that has no skill
  // install, and so a reviewer sees exactly which rules judged the pull request.
  await mkdir(join(vendorDir, 'scripts', 'lib'), { recursive: true });
  await mkdir(join(vendorDir, 'references'), { recursive: true });
  await cp(join(HERE, 'guard.mjs'), join(vendorDir, 'scripts', 'guard.mjs'));
  await cp(join(HERE, 'lib'), join(vendorDir, 'scripts', 'lib'), { recursive: true });
  await cp(DEFAULT_RULES, join(vendorDir, 'references', 'rules.json'));

  const checksums = {};
  const libFiles = (await readdir(join(HERE, 'lib'))).filter((f) => f.endsWith('.mjs')).map((f) => join('lib', f));
  for (const rel of ['guard.mjs', ...libFiles]) {
    const body = await readFile(join(vendorDir, 'scripts', rel));
    checksums[rel] = createHash('sha256').update(body).digest('hex').slice(0, 16);
  }
  checksums['rules.json'] = createHash('sha256').update(await readFile(DEFAULT_RULES)).digest('hex').slice(0, 16);
  await writeFile(join(vendorDir, 'PROVENANCE.json'), `${JSON.stringify({
    vendoredBy: 'structure-guard',
    source: HERE,
    installedAt: new Date().toISOString(),
    note: 'Re-run `guard.mjs ci install --force` after updating the skill so the vendored engine matches. rules.json is the versioned contract this repo is judged against.',
    checksums,
  }, null, 2)}\n`);

  const workflow = `${CI_MARKER} — regenerate with \`guard.mjs ci install --force\`, remove with \`guard.mjs ci remove\`.
name: structure-guard

on:
  push:
    branches: [main, master]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  structure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Structure and drift audit
        run: node ${relativeEntry} audit . --json --out structure-report.json
      # Add \`--strict\` above to fail the job on warnings as well as errors.
      - name: Architecture digest is current
        run: node ${relativeEntry} digest . --check
      - name: Upload structure report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: structure-report
          path: structure-report.json
          if-no-files-found: ignore
`;
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, workflow);

  // Keep the vendored engine out of its own measurements.
  const configPath = join(dir, STRUCTURE_DIR, 'guard.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.ignore = [...new Set([...(config.ignore ?? []), `${relativeVendor}/**`])];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  process.stdout.write(`vendored the engine into ${relativeVendor}/ (${Object.keys(checksums).length} files)\n`);
  process.stdout.write(`wrote ${workflowRel}\n`);
  process.stdout.write('CI gate: errors fail the build, the digest must be current; warnings are reported, not fatal.\n');
  return 0;
}

async function cmdAgents(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config } = await loadConfig(dir);
  const s = await snapshot(dir, flags, config);
  const rel = flags.out ?? 'AGENTS.md';
  const outPath = isAbsolute(rel) ? rel : join(dir, rel);
  const existing = existsSync(outPath) ? await readFile(outPath, 'utf8') : undefined;

  if (existing !== undefined && !existing.includes('structure-guard: generated') && flags.force !== true) {
    fail(`${rel} exists and was not generated by structure-guard; pass --force to replace it (its CURATED block would be preserved)`);
  }

  let findings = [];
  let summary;
  if (flags['no-audit'] !== true) {
    const result = await auditOnce(dir, flags);
    findings = result.findings;
    summary = summarize(findings);
  }
  const markdown = renderAgents(s, { config, findings, existing, guardCommand: `node ${join(HERE, 'guard.mjs')}` });

  if (flags.check === true) {
    process.stdout.write(existing === markdown ? 'AGENTS.md up to date\n' : 'AGENTS.md stale — regenerate\n');
    return existing === markdown ? 0 : 1;
  }
  await writeFile(outPath, markdown);
  process.stdout.write(`wrote ${outPath}${summary ? ` (audit: ${summary.error} error, ${summary.warn} warn)` : ''}\n`);
  return 0;
}

const VERIFY_STEPS = ['typecheck', 'test', 'build'];

async function cmdVerify(positional, flags) {
  const dir = projectDir(positional, flags);
  const { config } = await loadConfig(dir);
  const s = await snapshot(dir, flags, config);
  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, 'utf8')) : {};
  const scripts = pkg.scripts ?? {};
  const only = flags.only ? String(flags.only).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  const wanted = (only ?? VERIFY_STEPS).filter((name) => scripts[name] !== undefined);
  const timeout = Number.parseInt(flags.timeout ?? '900', 10) * 1000;
  const manager = { pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', npm: 'npm' }[s.conventions.packageManager] ?? 'npm';

  const report = { dir, audit: undefined, steps: [], ok: true };

  if (flags['no-audit'] !== true) {
    const result = await auditOnce(dir, flags);
    const sum = summarize(result.findings);
    report.audit = { score: score(sum), summary: sum, drift: result.drift.length };
    if (sum.error > 0) report.ok = false;
  }

  for (const name of wanted) {
    const started = Date.now();
    const run = spawnSync(manager, ['run', name], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
    const ms = Date.now() - started;
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const status = run.error !== undefined ? 'error' : run.status === 0 ? 'pass' : 'fail';
    if (status !== 'pass') report.ok = false;
    report.steps.push({
      name,
      command: `${manager} run ${name}`,
      status,
      ms,
      exitCode: run.status,
      error: run.error?.message,
      outputTail: output.split('\n').filter(Boolean).slice(-8),
    });
  }

  if (flags.json === true) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (flags.out) await writeFile(resolve(flags.out), text);
    else process.stdout.write(text);
    return report.ok ? 0 : 1;
  }

  process.stdout.write(`structure-guard verify — ${s.project.name ?? dir}\n\n`);
  if (report.audit !== undefined) {
    const a = report.audit;
    process.stdout.write(`  audit     ${a.summary.error === 0 ? 'pass' : 'FAIL'}  score ${a.score}/100 — ${a.summary.error} error, ${a.summary.warn} warn, ${a.summary.info} info${a.drift > 0 ? `, ${a.drift} drift` : ''}\n`);
  }
  if (wanted.length === 0) {
    process.stdout.write(existsSync(pkgPath)
      ? '  scripts   none declared (add typecheck / test / build to package.json)\n'
      : '  scripts   no package.json — structure gate only\n');
  }
  for (const step of report.steps) {
    const label = step.status === 'pass' ? `${c.green}pass${c.reset}` : step.status === 'fail' ? `${c.red}FAIL${c.reset}` : `${c.red}error${c.reset}`;
    process.stdout.write(`  ${step.name.padEnd(9)} ${label}  ${(step.ms / 1000).toFixed(1)}s  (${step.command})\n`);
    if (step.status !== 'pass') {
      for (const line of step.outputTail) process.stdout.write(`      ${line}\n`);
    }
  }
  process.stdout.write(`\n${report.ok ? `${c.green}verify: ok${c.reset}` : `${c.red}verify: failed${c.reset}`} — structure gate${wanted.length > 0 ? ` + ${wanted.join(', ')}` : ''}\n`);
  return report.ok ? 0 : 1;
}

async function cmdDoctor() {
  const problems = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) problems.push(`Node ${process.versions.node} is older than the supported 20`);
  const doc = await readJson(DEFAULT_RULES);
  if (!doc) problems.push(`cannot read ${DEFAULT_RULES}`);
  else {
    const ids = new Set();
    for (const rule of doc.rules ?? []) {
      if (ids.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`);
      ids.add(rule.id);
      if (typeof CHECKS[rule.check] !== 'function') problems.push(`rule ${rule.id} references unknown check "${rule.check}"`);
      if (!['error', 'warn', 'info'].includes(rule.severity)) problems.push(`rule ${rule.id} has severity "${rule.severity}"`);
    }
    process.stdout.write(`rules: ${ids.size} loaded from ${DEFAULT_RULES}\n`);
  }
  const unused = Object.keys(CHECKS).filter((name) => !(doc?.rules ?? []).some((r) => r.check === name));
  if (unused.length > 0) process.stdout.write(`${c.dim}checks not referenced by any rule: ${unused.join(', ')}${c.reset}\n`);
  for (const lib of ['scan.mjs', 'checks.mjs', 'digest.mjs']) {
    const p = join(HERE, 'lib', lib);
    if (!existsSync(p)) problems.push(`missing ${p}`);
  }
  process.stdout.write(`snapshot version: ${SNAPSHOT_VERSION} · node ${process.versions.node} · skill root ${SKILL_ROOT}\n`);
  if (problems.length > 0) {
    for (const p of problems) process.stdout.write(`${c.red}problem:${c.reset} ${p}\n`);
    return 1;
  }
  process.stdout.write(`${c.green}doctor: ok${c.reset}\n`);
  return 0;
}

// ── entry ───────────────────────────────────────────────────────────────────

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

if (!command || flags.help === true) {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 2);
}

let code = 0;
try {
  switch (command) {
    case 'scan': code = await cmdScan(positional.slice(1), flags); break;
    case 'init': code = await cmdInit(positional.slice(1), flags); break;
    case 'audit': code = await cmdAudit(positional.slice(1), flags); break;
    case 'diff': code = await cmdDiff(positional.slice(1), flags); break;
    case 'digest': code = await cmdDigest(positional.slice(1), flags); break;
    case 'baseline': {
      const dir = projectDir(positional.slice(1), flags);
      const { config } = await loadConfig(dir);
      const path = await cmdBaseline(dir, flags, config);
      process.stdout.write(`${c.green}wrote${c.reset} ${path}\n`);
      code = 0;
      break;
    }
    case 'hook': code = await cmdHook(positional.slice(1), flags); break;
    case 'watch': code = await cmdWatch(positional.slice(1), flags); break;
    case 'remote': code = await cmdRemote(positional.slice(1), flags); break;
    case 'ci': code = await cmdCi(positional.slice(1), flags); break;
    case 'agents': code = await cmdAgents(positional.slice(1), flags); break;
    case 'verify': code = await cmdVerify(positional.slice(1), flags); break;
    case 'doctor': code = await cmdDoctor(); break;
    default: fail(`unknown command "${command}"\n\n${USAGE}`);
  }
} catch (error) {
  fail(error?.stack ?? String(error));
}
process.exit(code);
