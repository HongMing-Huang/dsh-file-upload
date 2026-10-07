// Rule engine: built-in structural checks plus baseline drift diffing.
//
// A "check" is a pure function (snapshot, params, context) => findings[].
// Rules come from references/rules.json (industry defaults, evidenced by real
// open-source repos) and can be overridden per project in .structure/guard.json.
//
// Finding shape: { ruleId, severity, category, message, evidence[], suggestion }

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { LIBRARY_ROOTS, NON_LIBRARY_ROOTS, namingStyle } from './scan.mjs';

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

// ── helpers ─────────────────────────────────────────────────────────────────

export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

function matchAny(path, patterns) {
  return (patterns ?? []).some((p) => globToRegExp(p).test(path));
}

/**
 * Size class of a project, calibrated against the observed distribution of 18
 * large open-source repositories (see references/industry-standards.md):
 * small <500 tracked files, mid <5000, large >=5000.
 */
export function sizeClass(s) {
  const files = s?.metrics?.files ?? 0;
  if (files < 500) return 'small';
  if (files < 5000) return 'mid';
  return 'large';
}

/**
 * Resolve a threshold that may be declared per size class, either for the whole
 * rule (`params.bySize`) or for one key (`params[key].bySize`). The key-scoped
 * form is what a rule with two independent ceilings needs.
 */
function sizeParam(s, params, key, fallback) {
  const cls = sizeClass(s);
  const value = params[key];
  if (value !== null && typeof value === 'object' && value.bySize) {
    return value.bySize[cls] ?? fallback;
  }
  if (value !== undefined) return value;
  const bySize = params.bySize;
  if (bySize && bySize[cls] !== undefined) return bySize[cls];
  return fallback;
}

function tail(list, n) {
  return list.slice(0, n);
}

function pct(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/** True when the test tree is subdivided by kind or mirrors the module layout. */
function testTreeSubdivided(s) {
  const tests = s.__entries.filter((e) => e.kind === 'test');
  if (tests.length === 0) return false;
  if (tests.some((e) => /(^|\/)(unit|e2e|integration|fuzz|conformance|bench|perf|snapshot|fixtures?)(\/|$)/i.test(e.path))) return true;
  return new Set(tests.map((e) => dirname(e.path))).size > 4;
}

// ── built-in checks ─────────────────────────────────────────────────────────

export const CHECKS = {
  rootFileCount(s, p) {
    const max = sizeParam(s, p, 'max', 20);
    const count = s.metrics.topLevelFileCount;
    if (count <= max) return [];
    const files = s.__entries.filter((e) => !e.path.includes('/')).map((e) => e.path).sort();
    return [{
      message: `${count} loose files at the repository root (limit ${max}).`,
      evidence: tail(files, 12),
      suggestion: 'Move config into a single tool config or `.github/`, docs into `docs/`, scripts into `scripts/`. Root should read as a table of contents, not a drawer.',
    }];
  },

  rootConfigCount(s, p) {
    const max = sizeParam(s, p, 'max', 12);
    const configs = s.__entries.filter((e) => !e.path.includes('/') && e.kind === 'config').map((e) => e.path).sort();
    if (configs.length <= max) return [];
    return [{
      message: `${configs.length} tool-config files at the root (limit ${max}).`,
      evidence: tail(configs, 12),
      suggestion: 'Consolidate: one linter/formatter config family, and prefer tools that read from `package.json` fields over separate dotfiles.',
    }];
  },

  topLevelSprawl(s, p) {
    const max = sizeParam(s, p, 'max', 10);
    const count = s.metrics.topLevelDirCount ?? 0;
    if (count <= max) return [];
    const dirs = s.topLevel.filter((t) => t.type === 'dir').map((t) => t.path).sort();
    return [{
      message: `${count} top-level directories (limit ${max} for a ${sizeClass(s)} project).`,
      evidence: tail(dirs, 16),
      suggestion: 'Every root directory is a claim about how the project is organized. Merge the ones that describe the same concern, or move supporting material under `scripts/`, `docs/`, `tools/`.',
    }];
  },

  maxDirDepth(s, p) {
    const max = sizeParam(s, p, 'max', 8);
    if (s.metrics.maxDepth <= max) return [];
    const deep = s.__entries
      .filter((e) => e.path.split('/').length - 1 > max)
      .map((e) => e.path)
      .sort();
    return [{
      message: `Nesting reaches depth ${s.metrics.maxDepth} (limit ${max}).`,
      evidence: tail(deep, 10),
      suggestion: 'Flatten: deep trees hide module boundaries. Group by feature at 2-3 levels and keep implementation detail inside files, not folders.',
    }];
  },

  largestSourceFile(s, p) {
    const max = p.maxLines ?? 800;
    const offenders = s.__entries
      .filter((e) => e.kind === 'source' && e.lines > max && !/\.(test-d|spec|test)\./.test(e.path))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, p.report ?? 10);
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} source file(s) exceed ${max} lines; largest is ${offenders[0].path} at ${offenders[0].lines}.`,
      evidence: offenders.map((e) => `${e.path} (${e.lines} lines)`),
      suggestion: 'Split by responsibility. A file that large usually holds several modules; extract the ones other files need and keep the rest private.',
    }];
  },

  longFileRatio(s, p) {
    const max = sizeParam(s, p, 'maxLines', 800);
    const ratio = sizeParam(s, p, 'maxRatio', 0.05);
    const sources = s.__entries.filter((e) => e.kind === 'source');
    if (sources.length < 8) return [];
    const long = sources.filter((e) => e.lines > max);
    const share = long.length / sources.length;
    if (share <= ratio) return [];
    return [{
      message: `${(share * 100).toFixed(1)}% of source files exceed ${max} lines (limit ${(ratio * 100).toFixed(1)}%). `,
      evidence: tail(long.sort((a, b) => b.lines - a.lines).map((e) => `${e.path} (${e.lines})`), 10),
      suggestion: 'This is a systemic decomposition problem, not one bad file. Introduce module boundaries and an internal entry per feature.',
    }];
  },

  dirFileCount(s, p) {
    const max = sizeParam(s, p, 'maxFiles', 40);
    const skip = /(^|\/)(tests?|__tests__|specs?|snapshots|docs?|fixtures?|changelogs?)(\/|$)/i;
    const offenders = [];
    for (const [dir, bucket] of Object.entries(s.__dirStats ?? {})) {
      if (skip.test(`${dir}/`)) continue;
      if (bucket.directFiles > max) offenders.push({ dir, count: bucket.directFiles });
    }
    offenders.sort((a, b) => b.count - a.count);
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} director(y|ies) hold more than ${max} files directly; worst is ${offenders[0].dir} with ${offenders[0].count}.`,
      evidence: tail(offenders.map((o) => `${o.dir}/ (${o.count} files)`), 10),
      suggestion: 'A flat directory that big has no readable boundary. Group into subdirectories by feature or role.',
    }];
  },

  testPresence(s, p) {
    const minFiles = p.minFiles ?? 1;
    if (s.metrics.testFiles >= minFiles) return [];
    if (s.metrics.sourceFiles === 0) return [];
    return [{
      message: `No test files found for ${s.metrics.sourceFiles} source files.`,
      evidence: [],
      suggestion: 'Add a test root (`test/`, `tests/`, or beside-source `*.test.ts`) and a `test` script. Untested structure cannot be refactored safely, which is exactly when drift starts.',
    }];
  },

  testRatio(s, p) {
    const min = p.min ?? 0.25;
    if (s.metrics.sourceFiles < 10) return [];
    const ratio = s.metrics.testToSourceRatio;
    if (ratio >= min) return [];
    return [{
      message: `Test-to-source file ratio is ${ratio} (expected >= ${min}).`,
      evidence: [],
      suggestion: 'Prioritize tests on the modules with the highest fan-in and churn; those are the ones whose drift costs the most.',
    }];
  },

  mixedTestStyles(s, p) {
    if (s.conventions.testStyle !== 'both') return [];
    if (testTreeSubdivided(s)) return [];
    return [{
      message: 'Tests live both beside source and in a separate test root, and neither tree is subdivided.',
      evidence: tail(s.__entries.filter((e) => e.kind === 'test').map((e) => e.path), 8),
      suggestion: 'All three legal shapes are documented in the reference set: beside-source only (`packages/*/tests/`, `__tests__/`, `*_test.go`), one top-level `test/`, or both with the top-level tree split by kind. Pick one and apply it everywhere.',
    }];
  },

  docsPresence(s, p) {
    const required = p.required ?? ['readme', 'license'];
    const missing = required.filter((key) => s.presence[key] === false);
    if (missing.length === 0) return [];
    return [{
      message: `Missing standard root document(s): ${missing.join(', ')}.`,
      evidence: [],
      suggestion: 'These are the entry points every reviewer (and every agent) reads first. Their absence is the earliest sign of an unmaintained structure.',
    }];
  },

  architectureDoc(s, p) {
    if (s.presence.architectureDoc || s.presence.docsDir || s.presence.adrDir) return [];
    if (s.metrics.sourceFiles < (p.minSourceFiles ?? 50)) return [];
    return [{
      message: `No ARCHITECTURE/DESIGN document and no docs/ tree for a ${s.metrics.sourceFiles}-file codebase.`,
      evidence: [],
      suggestion: 'Run `guard.mjs digest` to generate one, then curate it. It is the baseline the drift check compares intent against.',
    }];
  },

  docsRatio(s, p) {
    const min = p.min ?? 0.05;
    if (s.metrics.sourceLoc < 2000) return [];
    const ratio = s.metrics.sourceLoc === 0 ? 0 : s.metrics.docLoc / s.metrics.sourceLoc;
    if (ratio >= min) return [];
    return [{
      message: `Documentation is ${pct(s.metrics.docLoc, s.metrics.sourceLoc)}% of source volume (expected >= ${Math.round(min * 100)}%).`,
      evidence: [],
      suggestion: 'Document module intent, not implementation. One paragraph per module in ARCHITECTURE.md beats scattered comments.',
    }];
  },

  ciPresence(s) {
    if (s.presence.ci) return [];
    return [{
      message: 'No CI workflow found.',
      evidence: [],
      suggestion: 'Without CI, structural rules are advisory only. Add a workflow that runs typecheck, tests, and `guard.mjs audit --strict`.',
    }];
  },

  linterPresence(s) {
    const findings = [];
    if (!s.presence.linterConfig && !s.presence.formatterConfig) {
      findings.push({
        message: 'No linter or formatter configuration found.',
        evidence: [],
        suggestion: 'Naming and import-order drift is cheapest to stop with a formatter plus lint rules committed at the root. Every repository in the reference set has one.',
      });
    } else if (!s.presence.formatterConfig) {
      findings.push({
        severity: 'info',
        message: 'A linter is configured but no formatter is.',
        evidence: [],
        suggestion: 'Split the two concerns: the formatter owns layout, the linter owns correctness. Without a formatter, style arguments reappear in every review.',
      });
    }
    return findings;
  },

  typeConfigPresence(s) {
    const tsFiles = s.__entries.filter((e) => e.lang === 'typescript' || e.lang === 'typescriptreact').length;
    if (tsFiles === 0 || s.presence.typeConfig) return [];
    return [{
      message: `${tsFiles} TypeScript files but no tsconfig*.json.`,
      evidence: [],
      suggestion: 'Module resolution and strictness must be declared, or every consumer guesses the boundary between public and internal types.',
    }];
  },

  lockfilePresence(s) {
    if (s.presence.lockfile) return [];
    const managers = ['pnpm', 'npm', 'yarn', 'bun'];
    if (!managers.includes(s.conventions.packageManager)) return [];
    return [{
      message: `${s.conventions.packageManager} project without a committed lockfile.`,
      evidence: [],
      suggestion: 'Commit the lockfile; reproducible installs are a structural guarantee, not a convenience.',
    }];
  },

  gitignorePresence(s) {
    if (s.presence.gitignore || !s.git?.isRepo) return [];
    return [{
      message: 'Git repository without .gitignore.',
      evidence: [],
      suggestion: 'Build output and local state will drift into commits and then into the module graph.',
    }];
  },

  exportsTargetsExist(s, p, ctx) {
    const pkg = ctx.rootPackage;
    if (!pkg) return [];
    const targets = [];
    const collect = (value) => {
      if (typeof value === 'string') targets.push(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
    };
    collect(pkg.exports);
    if (pkg.main) targets.push(pkg.main);
    if (pkg.types) targets.push(pkg.types);
    const missing = [...new Set(targets
      .filter((t) => typeof t === 'string' && t.startsWith('./'))
      .map((t) => t.replace(/^\.\//, ''))
      .filter((t) => !ctx.fileSet.has(t)))];
    if (missing.length === 0) return [];
    // Distinguish "declared output of a build step" from "broken pointer".
    const onDisk = missing.filter((t) => ctx.dir && existsSync(join(ctx.dir, t)));
    const broken = missing.filter((t) => !onDisk.includes(t));
    const findings = [];
    if (broken.length > 0) {
      findings.push({
        severity: 'error',
        message: `package.json entry points at ${broken.length} path(s) that exist neither in git nor on disk.`,
        evidence: tail(broken, 8),
        suggestion: 'The export map is stale: a consumer resolving this package gets ENOENT. Fix the path or build the target.',
      });
    }
    if (onDisk.length > 0) {
      const declared = (ctx.rootPackage?.files ?? []).some((f) => onDisk.some((t) => t === f || t.startsWith(`${String(f).replace(/\/$/, '')}/`)));
      findings.push({
        severity: declared ? 'info' : 'warn',
        message: `${onDisk.length} entry point(s) are untracked build output${declared ? '' : ' and are not listed in package.json `files`'}.`,
        evidence: tail(onDisk, 8),
        suggestion: declared
          ? 'Expected for a compiled package: keep the output directory ignored, declared in `files`, and reproducible from a `build` script.'
          : 'Declare the output directory in `files` (and ignore it in git) so what ships is explicit.',
      });
    }
    return findings;
  },

  buildScriptPresence(s) {
    const scripts = s.project.scripts ?? [];
    const needsBuild = (s.project.exportsMap || s.project.main) && scripts.length > 0;
    if (!needsBuild) return [];
    if (scripts.some((x) => /^(build|compile|prepare)$/.test(x))) return [];
    return [{
      message: 'Package declares entry points but has no build/compile script.',
      evidence: scripts,
      suggestion: 'Make the source→output relationship explicit; an undocumented build step is how output directories get committed and mistaken for source.',
    }];
  },

  testScriptPresence(s) {
    if (s.metrics.testFiles === 0) return [];
    const scripts = s.project.scripts ?? [];
    if (scripts.some((x) => /^test/.test(x))) return [];
    return [{
      message: 'Tests exist but no `test` script is declared.',
      evidence: scripts,
      suggestion: 'Declare `test` so CI, hooks, and other agents can run it without guessing the runner.',
    }];
  },

  typecheckScriptPresence(s) {
    const ts = s.__entries.some((e) => e.lang === 'typescript' || e.lang === 'typescriptreact');
    if (!ts) return [];
    const scripts = s.project.scripts ?? [];
    const commands = s.project.scriptCommands ?? {};
    const declared = scripts.some((x) => /^(typecheck|type-check|tsc|check-types?)$/.test(x));
    const runsTsc = Object.values(commands).some((cmd) => /(^|[\s&|;(])tsc([\s&|;)]|$)/.test(String(cmd)));
    if (declared || runsTsc) return [];
    return [{
      message: 'TypeScript project without a `typecheck` script.',
      evidence: scripts.slice(0, 12),
      suggestion: 'Add `"typecheck": "tsc --noEmit"`; structure guards and CI both need a fast, side-effect-free correctness gate.',
    }];
  },

  dependencyCount(s, p) {
    const max = p.max ?? 60;
    const count = s.project.dependencies ?? 0;
    if (count <= max) return [];
    return [{
      message: `${count} runtime dependencies (limit ${max}).`,
      evidence: [],
      suggestion: 'Every dependency is an unversioned structural commitment. Audit for overlap; a library per small utility is a common drift pattern.',
    }];
  },

  namingConsistency(s, p) {
    const min = p.min ?? 0.75;
    const total = Object.values(s.conventions.fileNaming).reduce((a, b) => a + b, 0);
    if (total < 10) return [];
    if (s.conventions.namingConsistency >= min) return [];
    const breakdown = Object.entries(s.conventions.fileNaming).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    return [{
      message: `File naming is only ${Math.round(s.conventions.namingConsistency * 100)}% consistent (dominant: ${s.conventions.dominantFileNaming}).`,
      evidence: breakdown.map(([style, n]) => `${style}: ${n}`),
      suggestion: `Standardize on ${s.conventions.dominantFileNaming}-case for new files and rename the outliers. Mixed conventions make module identity ambiguous.`,
    }];
  },

  duplicatedBasenames(s, p) {
    const max = p.maxCount ?? 3;
    const boilerplate = /(^|\/)(samples?|examples?|integration|e2e|tests?|__tests__|fixtures?|playground|demos?|templates?)(\/|$)/i;
    const configish = /\.(config|conf)\.[cm]?[jt]s$|^(tsconfig|vitest\.config|jest\.config|vite\.config|webpack\.config)/i;
    const offenders = s.duplicatedBasenames
      .map((d) => ({ ...d, paths: d.paths.filter((path) => !boilerplate.test(path)) }))
      .filter((d) => d.paths.length > max && !configish.test(d.name));
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} file name(s) are duplicated across more than ${max} directories.`,
      evidence: tail(offenders.map((d) => `${d.name} x${d.count}: ${d.paths.slice(0, 3).join(', ')}`), 8),
      suggestion: 'Duplicated names usually mean duplicated responsibilities. Consolidate into one shared module or rename to make the difference explicit.',
    }];
  },

  cycles(s, p) {
    const max = p.max ?? 0;
    const cross = s.graph.crossModuleCycleCount ?? 0;
    if (cross <= max) return [];
    return [{
      message: `${cross} import cycle(s) cross a module boundary (limit ${max}).`,
      evidence: tail((s.graph.crossModuleCycles ?? []).map((mods) => mods.join(' <-> ')), 8),
      suggestion: 'A cycle between modules means two of them cannot be reasoned about, tested, or extracted independently. Move the shared code down a layer or invert the dependency.',
    }];
  },

  intraModuleCycles(s, p) {
    const max = p.max ?? 8;
    const intra = s.graph.intraModuleCycleCount ?? 0;
    if (intra <= max) return [];
    return [{
      message: `${intra} import cycle(s) inside a single module (tolerated up to ${max}).`,
      evidence: tail(s.graph.cycles.map((c) => c.slice(0, 4).join(' -> ')), 6),
      suggestion: 'Cohesive packages do accumulate small internal cycles; past a handful they signal a missing internal seam. Split the file group that keeps reaching back.',
    }];
  },

  moduleCycles(s, p) {
    const max = p.max ?? 0;
    const byName = new Map(s.modules.map((m) => [m.name, m]));
    const isTestish = (m) => /(^|\/)(tests?|specs?|__tests__)(\/|$)/i.test(m.root) || m.name === 'test' || m.name === 'tests';
    const cyclic = s.modules.filter((m) => {
      if (isTestish(m)) return false;
      return (m.imports ?? []).some((dep) => {
        const other = byName.get(dep);
        // Report each undirected pair once, under the alphabetically first name.
        if (dep < m.name) return false;
        return other !== undefined && !isTestish(other) && (other.imports ?? []).includes(m.name);
      });
    });
    if (cyclic.length <= max) return [];
    return [{
      message: `${cyclic.length} module(s) participate in a module-level import cycle.`,
      evidence: tail(cyclic.map((m) => `${m.name} <-> ${(m.imports ?? []).filter((d) => (byName.get(d)?.imports ?? []).includes(m.name)).join(', ')}`), 8),
      suggestion: 'Module cycles mean the decomposition is wrong, not the imports. Re-cut along the dependency direction. (Test modules importing source is expected and excluded.)',
    }];
  },

  orphanModules(s, p) {
    if (s.modules.length < 3) return [];
    const entryish = /(app|apps|bin|cmd|cli|main|index|entry|pages|routes|site|docs?|examples?|demos?|playground|sandbox|tools?|scripts?|tests?|specs?|benchmarks?|fixtures?|templates?|e2e|cypress|private|debug|explorer|\.github|\(root\))/i;
    const packaged = new Set(s.project.nestedPackages ?? []);
    const orphans = s.modules.filter((m) => (m.importedBy ?? []).length === 0
      && m.sourceFiles > 0
      && !entryish.test(m.name)
      && !packaged.has(m.root)
      && !matchAny(m.root, p.allow ?? []));
    if (orphans.length <= (p.max ?? 0)) return [];
    return [{
      message: `${orphans.length} module(s) are imported by nothing and are not an entry point.`,
      evidence: tail(orphans.map((m) => `${m.root}/ (${m.sourceFiles} source files)`), 8),
      suggestion: 'Either dead code, or a module whose consumer wires it dynamically. Confirm and delete, or document the wiring in ARCHITECTURE.md.',
    }];
  },

  godModule(s, p) {
    // In a monorepo a module is a whole published package, so the ceiling that
    // makes sense for a subdirectory of one package would flag half of every
    // large, well-run repository.
    const isMonorepo = String(s.project.archetype).startsWith('monorepo');
    const maxLoc = isMonorepo ? sizeParam(s, p, 'maxPackageLoc', 60000) : sizeParam(s, p, 'maxLoc', 12000);
    const maxFiles = isMonorepo ? sizeParam(s, p, 'maxPackageFiles', 500) : sizeParam(s, p, 'maxFiles', 250);
    const offenders = s.modules.filter((m) => m.loc > maxLoc || m.fileCount > maxFiles);
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} module(s) exceed the size ceiling for this archetype (${maxLoc} LOC / ${maxFiles} files).`,
      evidence: tail(offenders.map((m) => `${m.root}/ (${m.loc} LOC, ${m.fileCount} files)`), 8),
      suggestion: 'A module that big has no interface, only surface. Split it and give each half an entry point.',
    }];
  },

  monorepoConsistency(s, p) {
    if (!s.project.archetype.startsWith('monorepo')) return [];
    const findings = [];
    const pkgDirs = s.project.nestedPackages ?? [];
    if (pkgDirs.length > 0 && (s.project.workspaces ?? []).length === 0 && s.presence.workspaceManifest !== true) {
      findings.push({
        message: `${pkgDirs.length} nested packages but no workspaces declaration in the root manifest.`,
        evidence: tail(pkgDirs, 8),
        suggestion: 'Declare workspaces so the package graph is explicit; otherwise cross-package imports resolve by accident.',
      });
    }
    const prefixes = new Set(pkgDirs.map((d) => d.split('/')[0]));
    if (prefixes.size > (p.maxRoots ?? 2)) {
      findings.push({
        message: `Workspace members live under ${prefixes.size} different roots (${[...prefixes].join(', ')}).`,
        evidence: [...prefixes],
        suggestion: 'Large monorepos converge on one or two roots (`packages/`, `apps/`). More roots means the boundary rules are unwritten.',
      });
    }
    return findings;
  },

  boundaryViolation(s, p, ctx) {
    const boundaries = ctx.config?.boundaries;
    if (!boundaries || boundaries.length === 0) return [];
    const moduleOfFile = (file) => {
      for (const mod of ctx.config.modules ?? []) {
        if (matchAny(file, mod.paths ?? [])) return mod.name;
      }
      return undefined;
    };
    const allow = new Map(boundaries.map((b) => [b.from, new Set(b.mayImport ?? [])]));
    const violations = [];
    for (const edge of s.__crossEdges ?? []) {
      const from = moduleOfFile(edge.from);
      const to = moduleOfFile(edge.to);
      if (!from || !to || from === to) continue;
      const allowed = allow.get(from);
      if (allowed && !allowed.has(to) && !allowed.has('*')) {
        violations.push(`${edge.from} -> ${edge.to}  (${from} may not import ${to})`);
      }
    }
    if (violations.length === 0) return [];
    return [{
      message: `${violations.length} declared module boundary violation(s).`,
      evidence: tail(violations, 12),
      suggestion: 'This is drift with a name attached. Either move the code back behind the right interface, or amend `.structure/guard.json` deliberately and record why in ARCHITECTURE.md.',
    }];
  },

  layerViolation(s, p, ctx) {
    const modules = ctx.config?.modules ?? [];
    const layered = modules.filter((m) => Number.isFinite(m.layer));
    if (layered.length < 2) return [];
    const layerOf = (file) => {
      for (const mod of layered) if (matchAny(file, mod.paths ?? [])) return { name: mod.name, layer: mod.layer };
      return undefined;
    };
    const violations = [];
    for (const edge of s.__crossEdges ?? []) {
      const from = layerOf(edge.from);
      const to = layerOf(edge.to);
      if (!from || !to) continue;
      if (to.layer > from.layer) violations.push(`${edge.from} (layer ${from.layer}) -> ${edge.to} (layer ${to.layer})`);
    }
    if (violations.length === 0) return [];
    return [{
      message: `${violations.length} import(s) point from a lower layer to a higher one.`,
      evidence: tail(violations, 12),
      suggestion: 'Lower layers must not know about higher ones. Invert the dependency (callback, event, injected interface) or move the shared code down.',
    }];
  },

  vendoredCode(s, p) {
    const max = p.maxFiles ?? 0;
    if (s.metrics.vendoredFiles <= max) return [];
    return [{
      message: `${s.metrics.vendoredFiles} vendored/third-party files are committed.`,
      evidence: [],
      suggestion: 'Vendor only with a recorded reason (LICENSE + UPSTREAM file). Otherwise it hides real dependency structure and inflates every metric.',
    }];
  },

  generatedCommitted(s, p) {
    const max = p.maxFiles ?? 0;
    const generated = s.__entries.filter((e) => e.kind === 'generated');
    if (generated.length <= max) return [];
    return [{
      message: `${generated.length} generated artifacts (min/map/snap) are committed.`,
      evidence: tail(generated.map((e) => e.path), 8),
      suggestion: 'Generated output in the tree makes source and build indistinguishable. Ignore it, or isolate it in one declared output directory.',
    }];
  },

  secretsInRepo(s) {
    const risky = s.__entries.filter((e) => /(^|\/)\.env(\.|$)/.test(e.path) && !/\.example$|\.sample$|\.template$/.test(e.path));
    if (risky.length === 0) return [];
    return [{
      message: `${risky.length} .env file(s) are tracked in the repository.`,
      evidence: tail(risky.map((e) => e.path), 5),
      suggestion: 'Track `.env.example` instead. A committed .env is both a secret leak and a phantom config layer.',
    }];
  },

  longFunctions(s, p) {
    const max = sizeParam(s, p, 'maxLines', 120);
    const allow = new Set(p.allow ?? []);
    const roots = new Set([...NON_LIBRARY_ROOTS]);
    const offenders = (s.longestFunctions ?? []).filter((fn) => {
      if (fn.lines <= max) return false;
      if (allow.has(fn.name) || /factory$/i.test(fn.name)) return false;
      // Demo and integration apps exist to show an API, not to be maintained.
      const root = fn.path.split('/')[0];
      return !(roots.has(root) && !LIBRARY_ROOTS.has(root));
    });
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} function(s) exceed ${max} lines; the longest is ${offenders[0].name} at ${offenders[0].lines}.`,
      evidence: tail(offenders.slice(0, p.report ?? 6).map((fn) => `${fn.path}:${fn.startLine} ${fn.name} (${fn.lines} lines)`), 8),
      suggestion: 'Measured across the corpus the longest function is 19 lines in nitro, 78 in nest, ~80 in cordis; the two documented counterexamples are vite `resolveConfig` (861) and vue `baseCreateRenderer` (2169). Extract the phases of a long function into named steps, and keep closure factories that must share state as the documented exception.',
    }];
  },

  packageShape(s, p) {
    const shapes = s.project.packageShapes ?? [];
    const minPackages = p.minPackages ?? 4;
    const members = shapes.filter((pkg) => pkg.path !== '(root)');
    if (members.length < minPackages) return [];
    // Tiny packages are barrels, scaffolding or metadata; judge the rest.
    const judged = members.filter((pkg) => pkg.files >= (p.minFiles ?? 6));
    if (judged.length < minPackages) return [];
    const signature = (pkg) => [pkg.src ? 'src' : 'flat', pkg.tests ? 'tests' : 'no-tests', pkg.readme ? 'readme' : 'no-readme'].join('+');
    const counts = new Map();
    for (const pkg of judged) counts.set(signature(pkg), (counts.get(signature(pkg)) ?? 0) + 1);
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (majority === undefined || majority[1] / judged.length < (p.minShare ?? 0.75)) return [];
    const outliers = judged.filter((pkg) => signature(pkg) !== majority[0]);
    if (outliers.length === 0 || outliers.length > (p.maxOutliers ?? 6)) return [];
    return [{
      message: `${outliers.length} of ${judged.length} packages deviate from the ${majority[0]} shape the other ${majority[1]} share.`,
      evidence: tail(outliers.map((pkg) => `${pkg.path} (${signature(pkg)}, ${pkg.files} files)`), 8),
      suggestion: 'Package-shape uniformity is the cheapest high-value check in the corpus: vue 12/12, nest 9/9, cordis 9/9, biome 102/102 crates. A deviation is never accidental — cordis\' three test-less packages are exactly its scaffolding, meta and barrel packages. Either bring the outlier in line or record why its kind is exempt.',
    }];
  },

  internalPrivacy(s, p) {
    const count = s.graph.internalViolationCount ?? 0;
    if (count <= (p.max ?? 0)) return [];
    return [{
      message: `${count} import(s) reach into another module's internal/ (or _private) subtree.`,
      evidence: tail(s.graph.internalViolations ?? [], 10),
      suggestion: 'An internal directory is a promise that nothing outside its owner may depend on it. Import the owner\'s public entry instead, or promote the shared piece out of internal/. The strongest repos enforce this mechanically (vscode has a dedicated lint rule, vite seals it with `"./types/internal/*": null`).',
    }];
  },

  libraryIsolation(s, p) {
    const count = s.graph.isolationViolationCount ?? 0;
    if (count <= (p.max ?? 0)) return [];
    return [{
      message: `${count} import(s) from a library tree into an app/example/test/bench tree.`,
      evidence: tail(s.graph.isolationViolations ?? [], 10),
      suggestion: 'The dependency must point one way: examples and tests consume the library, never the reverse. A library that imports from `examples/` or `test/` cannot be published or reused. Every reference repository in the corpus holds this line.',
    }];
  },

  committedRuntimeArtifacts(s, p) {
    // Markers a program writes about its own state: probes, install receipts,
    // pid and cache files. They are regenerated at runtime, so tracking them
    // freezes one machine's state into the repository.
    const markers = [
      /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)\.probe$/,
      /(^|\/)[\w.-]*-installed\.json$/, /(^|\/)\.installed$/, /\.pid$/,
      /(^|\/)\.cache$/, /(^|\/)desktop\.ini$/i,
    ];
    const exempt = /(^|\/)(tests?|__tests__|fixtures?|specs?|docs?|examples?)(\/|$)/i;
    const hits = (s.__entries ?? []).filter((e) => !exempt.test(e.path) && markers.some((re) => re.test(e.path)));
    if (hits.length === 0) return [];
    return [{
      message: `${hits.length} runtime artifact(s) are tracked in git.`,
      evidence: tail(hits.map((e) => e.path), 8),
      suggestion: 'Delete them from the index and ignore the pattern. A committed probe or install receipt makes every other machine believe work was already done.',
    }];
  },

  committedBuildOutput(s, p) {
    const count = s.metrics.committedBuildOutput ?? 0;
    if (count <= (p.maxFiles ?? 0)) return [];
    return [{
      message: `${count} tracked file(s) live in a build-output directory.`,
      evidence: tail(s.committedBuildOutput ?? [], 8),
      suggestion: 'Ignore the output directory and rebuild it from a declared script. Committed output makes source and artifact indistinguishable, which is how stale builds ship.',
    }];
  },

  namingConvention(s, p, ctx) {
    const spec = ctx.config?.naming;
    if (!spec) return [];
    const findings = [];
    const fileRules = spec.files ?? {};
    for (const [glob, expected] of Object.entries(fileRules)) {
      const re = globToRegExp(glob.startsWith('*') ? glob : `**/${glob}`);
      // A single lowercase word satisfies kebab-case and snake_case, exactly as
      // ls-lint treats it; only genuinely different casing is a violation.
      const violates = (name) => {
        const style = namingStyle(name);
        if (style === expected) return false;
        return !(style === 'flat' && (expected === 'kebab' || expected === 'snake'));
      };
      const offenders = s.__entries
        .filter((e) => e.kind === 'source' && re.test(basename(e.path)) && violates(basename(e.path)))
        .map((e) => `${e.path} (${namingStyle(basename(e.path))})`);
      if (offenders.length === 0) continue;
      findings.push({
        severity: offenders.length > (p.maxViolations ?? 5) ? 'warn' : 'info',
        message: `${offenders.length} file(s) matching \`${glob}\` are not ${expected}-case.`,
        evidence: tail(offenders.sort(), 8),
        suggestion: `This project declared ${expected}-case for ${glob}. Either rename the outliers or amend the declaration — a rule that is routinely broken is worse than no rule.`,
      });
    }
    const dirRules = spec.directories ?? {};
    for (const [glob, expected] of Object.entries(dirRules)) {
      const re = globToRegExp(glob);
      const offenders = [];
      for (const dir of Object.keys(s.__dirStats ?? {})) {
        if (!re.test(dir)) continue;
        const last = dir.split('/').pop();
        const style = namingStyle(last);
        if (style !== expected && !(style === 'flat' && (expected === 'kebab' || expected === 'snake'))) {
          offenders.push(`${dir}/ (${style})`);
        }
      }
      if (offenders.length === 0) continue;
      findings.push({
        message: `${offenders.length} director(y|ies) matching \`${glob}\` are not ${expected}-case.`,
        evidence: tail(offenders.sort(), 8),
        suggestion: `Directory casing is part of the module's identity. rolldown declares exactly this in .ls-lint.json so two ecosystems can coexist in one repo.`,
      });
    }
    return findings;
  },

  testTreeOrganization(s, p) {
    const minFiles = p.minFiles ?? 40;
    if (s.metrics.testFiles < minFiles) return [];
    if (!['top-level', 'both'].includes(s.conventions.testStyle)) return [];
    const testRoots = new Set(s.__entries
      .filter((e) => e.kind === 'test')
      .map((e) => e.path.split('/').filter((seg) => ['test', 'tests', '__tests__', 'spec', 'specs'].includes(seg.toLowerCase()))[0]?.toLowerCase())
      .filter(Boolean));
    // A big test tree must be subdivided by kind, or mirror the module layout.
    if (testTreeSubdivided(s)) return [];
    return [{
      message: `${s.metrics.testFiles} test files sit in a flat ${[...testRoots].join('/')} tree.`,
      evidence: [],
      suggestion: 'Past a few dozen files, split the test root by kind (`test/{unit,e2e,integration,...}`) or mirror the module layout. vitest, cpython, deno, go and kubernetes all subdivide; next.js and vscode do not, and both are documented exceptions.',
    }];
  },

  agentInstructions(s, p) {
    if (s.presence.agentDocs) return [];
    if (s.metrics.sourceFiles < (p.minSourceFiles ?? 20)) return [];
    return [{
      message: `No agent instructions in a ${s.metrics.sourceFiles}-file codebase.`,
      evidence: [],
      suggestion: 'Add `AGENTS.md` (or `.agents/`) stating what the project is, the boundary rules, and where each kind of change belongs — the same three things the CURATED block of ARCHITECTURE.md holds. 10 of the 18 reference repositories ship one; nitro keeps `.agents/architecture.md` as a subsystem-to-file map. Without it, every agent session re-derives the layout, and vibe-coded changes drift fastest.',
    }];
  },

  machineEnforcement(s, p) {
    const found = s.presence.enforcementArtifacts ?? [];
    const minFiles = p.minSourceFiles ?? 50;
    if (found.length > 0 || s.metrics.sourceFiles < minFiles) return [];
    return [{
      message: `No machine-enforced structure rule in a ${s.metrics.sourceFiles}-file codebase.`,
      evidence: [],
      suggestion: 'The strongest repos encode layout rules as executable checks: vscode ships .eslint-plugin-local/code-layering.ts over a declared layer allow-map, kubernetes has 71 .import-restrictions files, rolldown declares .ls-lint.json, go freezes api/*.txt, vite seals internal types with a null export. `guard.mjs hook install` plus declared boundaries in .structure/guard.json is the minimum version of the same idea.',
    }];
  },

  coreDependencyCeiling(s, p) {
    const max = p.max ?? 5;
    const coreish = /(core|kernel|runtime|reactivity|compiler|effect|shared|common)$/i;
    const offenders = (s.project.packages ?? []).filter((pkg) => !pkg.private && coreish.test(pkg.path) && pkg.deps > max);
    if (offenders.length === 0) return [];
    return [{
      message: `${offenders.length} core/kernel package(s) carry more than ${max} runtime dependencies.`,
      evidence: tail(offenders.map((o) => `${o.path} (${o.deps} deps, ${o.peerDeps} peers)`), 8),
      suggestion: 'cordis/core ships 2 runtime deps, effect 0, nestjs/core puts all 5 framework packages in peerDependencies, vue 5 + peer typescript. Framework-adjacent packages belong in peerDependencies so the consumer picks the version.',
    }];
  },

  unresolvedImports(s, p) {
    const max = p.max ?? 0;
    const misses = s.graph.unresolvedSource ?? s.graph.unresolvedRelative ?? 0;
    if (misses <= max) return [];
    return [{
      message: `${misses} relative import(s) in production source do not resolve to a file in the tree (${s.graph.unresolvedTest ?? 0} further miss(es) inside test fixtures are ignored).`,
      evidence: tail(s.graph.unresolvedSamples ?? [], 8),
      suggestion: 'Usually a missing extension, a stale path after a move, or generated code. Every unresolved edge is a blind spot in the module graph.',
    }];
  },

  churnHotspots(s, p, ctx) {
    const churn = s.git?.churn90d;
    if (!churn || churn.length === 0) return [];
    const minCommits = p.minCommits ?? 12;
    const fanIn = new Map((s.mostImported ?? []).map((m) => [m.path, m.importedBy]));
    const hot = churn.filter((c) => c.commits >= minCommits && (fanIn.get(c.path) ?? 0) >= (p.minFanIn ?? 3));
    if (hot.length === 0) return [];
    return [{
      message: `${hot.length} file(s) are both frequently changed and widely imported.`,
      evidence: tail(hot.map((h) => `${h.path} (${h.commits} commits/90d, ${fanIn.get(h.path)} importers)`), 8),
      suggestion: 'These are the drift engines of the project: every change ripples. Stabilize their interface first, and put tests there before anywhere else.',
    }];
  },

  structureBaseline(s, p, ctx) {
    if (!ctx.hasBaseline) return [];
    const ageDays = ctx.baselineAgeDays;
    const max = p.maxAgeDays ?? 30;
    if (ageDays === undefined || ageDays <= max) return [];
    return [{
      message: `Structure baseline is ${Math.round(ageDays)} days old (limit ${max}).`,
      evidence: [ctx.baselinePath],
      suggestion: 'Re-run `guard.mjs audit` and accept or reject the drift; an unread baseline stops being a guard.',
    }];
  },

};

// ── drift diffing ───────────────────────────────────────────────────────────

const PRESENCE_KEYS = ['readme', 'license', 'changelog', 'contributing', 'ci', 'gitignore', 'lockfile', 'docsDir', 'architectureDoc'];

/** Compare a persisted baseline snapshot with the current one. */
export function diffSnapshots(baseline, current, config = {}) {
  const findings = [];
  const thresholds = config.thresholds ?? {};
  const push = (ruleId, severity, message, evidence, suggestion) => findings.push({ ruleId, severity, category: 'drift', message, evidence: evidence ?? [], suggestion });

  const baseTop = new Set((baseline.topLevel ?? []).map((t) => t.path));
  const curTop = new Set((current.topLevel ?? []).map((t) => t.path));
  const addedTop = [...curTop].filter((t) => !baseTop.has(t)).sort();
  const removedTop = [...baseTop].filter((t) => !curTop.has(t)).sort();
  if (addedTop.length > 0) {
    push('drift-new-top-level', thresholds.newTopLevelSeverity ?? 'warn',
      `${addedTop.length} new top-level entr(y|ies) since the baseline: ${addedTop.join(', ')}.`,
      addedTop,
      'A new root directory is a structural decision. Confirm it belongs to the declared archetype, then record its purpose in ARCHITECTURE.md and re-baseline.');
  }
  if (removedTop.length > 0) {
    push('drift-removed-top-level', 'info',
      `${removedTop.length} top-level entr(y|ies) removed since the baseline: ${removedTop.join(', ')}.`,
      removedTop,
      'Removals are usually intentional. Verify nothing still imports the old path and update the digest.');
  }

  if (baseline.project?.archetype !== current.project?.archetype) {
    push('drift-archetype-changed', 'error',
      `Project archetype changed from "${baseline.project?.archetype}" to "${current.project?.archetype}".`,
      [],
      'The layout family changed under you (for example single package became a monorepo). That invalidates every boundary rule; re-derive them deliberately.');
  }

  const baseMods = new Set((baseline.modules ?? []).map((m) => m.name));
  const curMods = new Set((current.modules ?? []).map((m) => m.name));
  const addedMods = [...curMods].filter((m) => !baseMods.has(m)).sort();
  const removedMods = [...baseMods].filter((m) => !curMods.has(m)).sort();
  if (addedMods.length > 0) {
    push('drift-new-modules', 'info', `New module(s): ${addedMods.join(', ')}.`, addedMods,
      'Give each new module a one-line purpose in ARCHITECTURE.md and decide whether it may be imported by others.');
  }
  if (removedMods.length > 0) {
    push('drift-removed-modules', 'info', `Module(s) disappeared: ${removedMods.join(', ')}.`, removedMods,
      'Check for stale imports and stale documentation references.');
  }

  const baseCycles = new Set((baseline.graph?.cycles ?? []).map((c) => c.join('|')));
  const newCycles = (current.graph?.cycles ?? []).filter((c) => !baseCycles.has(c.join('|')));
  if (newCycles.length > 0) {
    push('drift-new-cycles', 'error', `${newCycles.length} new import cycle(s) since the baseline.`,
      newCycles.slice(0, 6).map((c) => c.slice(0, 4).join(' -> ')),
      'New cycles are the sharpest drift signal available: a boundary that used to hold no longer does. Break them before they attract more code.');
  }

  const growth = thresholds.fileGrowthWarn ?? 0.4;
  const baseFiles = baseline.metrics?.files ?? 0;
  const curFiles = current.metrics?.files ?? 0;
  if (baseFiles > 20 && curFiles > baseFiles * (1 + growth)) {
    push('drift-file-growth', 'warn',
      `File count grew ${pct(curFiles - baseFiles, baseFiles)}% (${baseFiles} -> ${curFiles}) since the baseline.`,
      [],
      'Growth this fast usually means new concerns are being appended rather than placed. Re-read the module map and decide where each new area belongs.');
  }

  const locGrowth = thresholds.locGrowthWarn ?? 0.6;
  const baseLoc = baseline.metrics?.sourceLoc ?? 0;
  const curLoc = current.metrics?.sourceLoc ?? 0;
  if (baseLoc > 500 && curLoc > baseLoc * (1 + locGrowth)) {
    push('drift-loc-growth', 'info', `Source volume grew ${pct(curLoc - baseLoc, baseLoc)}% (${baseLoc} -> ${curLoc} LOC).`, [],
      'Volume alone is fine; volume without new module boundaries is not. Check `godModule` findings.');
  }

  const baseRatio = baseline.metrics?.testToSourceRatio ?? 0;
  const curRatio = current.metrics?.testToSourceRatio ?? 0;
  if (baseRatio > 0 && curRatio < baseRatio * (thresholds.testRatioDropWarn ?? 0.75)) {
    push('drift-test-ratio-drop', 'warn',
      `Test-to-source ratio fell from ${baseRatio} to ${curRatio}.`,
      [],
      'New code is landing without tests. That is the mechanism by which structure becomes unrefactorable.');
  }

  if ((current.metrics?.maxDepth ?? 0) > (baseline.metrics?.maxDepth ?? 0)) {
    push('drift-depth-increase', 'info',
      `Maximum nesting deepened from ${baseline.metrics?.maxDepth} to ${current.metrics?.maxDepth}.`,
      [],
      'Depth creeps when features get folders instead of interfaces. Flatten or justify.');
  }

  for (const key of PRESENCE_KEYS) {
    if (baseline.presence?.[key] === true && current.presence?.[key] === false) {
      push('drift-presence-regression', 'warn', `Standard artifact disappeared since the baseline: ${key}.`, [],
        'Regressions in root artifacts are almost always accidental deletions or a moved file nobody updated.');
    }
  }

  const conventionDrift = [];
  if (baseline.conventions?.dominantFileNaming && current.conventions?.dominantFileNaming
    && baseline.conventions.dominantFileNaming !== current.conventions.dominantFileNaming) {
    conventionDrift.push(`file naming ${baseline.conventions.dominantFileNaming} -> ${current.conventions.dominantFileNaming}`);
  }
  if (baseline.conventions?.testStyle && current.conventions?.testStyle
    && baseline.conventions.testStyle !== current.conventions.testStyle) {
    conventionDrift.push(`test placement ${baseline.conventions.testStyle} -> ${current.conventions.testStyle}`);
  }
  if (baseline.project?.moduleSystem && current.project?.moduleSystem
    && baseline.project.moduleSystem !== current.project.moduleSystem) {
    conventionDrift.push(`module system ${baseline.project.moduleSystem} -> ${current.project.moduleSystem}`);
  }
  if (baseline.conventions?.packageManager && current.conventions?.packageManager
    && baseline.conventions.packageManager !== current.conventions.packageManager) {
    conventionDrift.push(`package manager ${baseline.conventions.packageManager} -> ${current.conventions.packageManager}`);
  }
  if (conventionDrift.length > 0) {
    push('drift-convention-change', 'warn', `Conventions changed since the baseline: ${conventionDrift.join('; ')}.`, [],
      'Convention changes are legitimate, but they must be decided once and applied everywhere, not adopted file by file.');
  }

  const baseDeps = baseline.project?.dependencies ?? 0;
  const curDeps = current.project?.dependencies ?? 0;
  if (baseDeps > 0 && curDeps > baseDeps + (thresholds.dependencyJumpWarn ?? 8)) {
    push('drift-dependency-jump', 'info', `Runtime dependencies grew from ${baseDeps} to ${curDeps}.`, [],
      'Review the additions for overlap with existing dependencies before accepting them.');
  }

  const baseLargest = baseline.largestFiles?.[0];
  const curLargest = current.largestFiles?.[0];
  if (baseLargest && curLargest && curLargest.lines > baseLargest.lines * (thresholds.largestFileGrowthWarn ?? 1.5) && curLargest.lines > 600) {
    push('drift-largest-file-growth', 'warn',
      `Largest source file grew from ${baseLargest.path} (${baseLargest.lines}) to ${curLargest.path} (${curLargest.lines}).`,
      [curLargest.path],
      'A file that keeps absorbing code is a missing module. Split it now, while it is still cheap.');
  }

  return findings;
}

// ── runner ──────────────────────────────────────────────────────────────────

/**
 * Run a resolved rule list against a snapshot.
 * @param {object} snapshot full in-memory snapshot (with __entries/__dirStats/__crossEdges)
 * @param {Array} rules [{ id, check, severity, category, params, description, suggestion, evidence }]
 * @param {object} context { config, rootPackage, fileSet, hasBaseline, baselineAgeDays, baselinePath }
 */
export function runRules(snapshot, rules, context = {}) {
  const findings = [];
  for (const rule of rules) {
    const check = CHECKS[rule.check];
    if (typeof check !== 'function') {
      findings.push({
        ruleId: rule.id, severity: 'info', category: rule.category ?? 'meta',
        message: `Rule "${rule.id}" names unknown check "${rule.check}"; skipped.`,
        evidence: [], suggestion: 'Fix references/rules.json or the project override.',
      });
      continue;
    }
    let produced;
    try {
      produced = check(snapshot, rule.params ?? {}, context) ?? [];
    } catch (error) {
      findings.push({
        ruleId: rule.id, severity: 'info', category: rule.category ?? 'meta',
        message: `Rule "${rule.id}" failed to evaluate: ${error.message}`, evidence: [], suggestion: 'Report or disable the rule.',
      });
      continue;
    }
    for (const item of produced) {
      findings.push({
        ruleId: rule.id,
        severity: item.severity ?? rule.severity ?? 'warn',
        category: rule.category ?? 'structure',
        message: item.message,
        evidence: item.evidence ?? [],
        suggestion: item.suggestion ?? rule.suggestion ?? rule.description ?? '',
        standard: rule.evidence,
      });
    }
  }
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
    || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return findings;
}

export function summarize(findings) {
  const out = { error: 0, warn: 0, info: 0, total: findings.length };
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}
