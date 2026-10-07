/**
 * Longest-function scan.
 *
 * Structure guards usually stop at file size, but the corpus says otherwise: the
 * two worst offenders measured were single functions (vite `resolveConfig` 861
 * lines, vue `baseCreateRenderer` 2169) inside files that were not the largest
 * in their repo, while nitro's longest function was 19 lines. This module finds
 * function bodies with a small state machine instead of a parser, so it stays
 * dependency-free and fast enough to run on every source file in a scan.
 *
 * It is deliberately conservative: a header it does not recognise is simply not
 * measured, and lengths are only ever reported, never used to fail a build on
 * their own.
 */

const BRACE_LANGS = new Set(['javascript', 'typescript', 'vue', 'svelte', 'go', 'rust']);
const INDENT_LANGS = new Set(['python']);

const KEYWORD_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'await',
  'typeof', 'new', 'function', 'class', 'const', 'let', 'var', 'export', 'import',
  'case', 'default', 'yield', 'with', 'delete', 'in', 'of', 'instanceof', 'throw',
  'void', 'this', 'super', 'static', 'get', 'set', 'async',
]);

// Header patterns per language family. `name` is the first capture group.
const BRACE_HEADERS = [
  // function declarations, including generators and `export default function`
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
  // const f = (...) => / const f = function / const f: T = async (...) =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\s*\*?\s*[(<]|\(|[A-Za-z_$][\w$]*\s*=>)/,
  // class or object methods: `name(args) {` / `async name(args) {` / `get name() {`
  /^\s{2,}(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{;]+)?\{\s*$/,
  // go: func name( / func (recv) name(
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/,
  // rust: [pub] [async] [unsafe] fn name
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
];

const PYTHON_HEADER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/;

// A line that starts a fresh statement. Used to abandon a header whose body never
// opened: an arrow with an expression body (`const isKeepAlive = (i) => ...`) has
// no brace of its own, and attributing the next object literal to it would invent
// a 300-line function. Repos without semicolons (vue) need this rather than `;`.
const STATEMENT_START = /^\s*(?:export|import|const|let|var|type|interface|class|function|return|if|for|while|switch|try|declare|enum|namespace|module|package|use|fn|func|def|impl|struct|pub|from)\b/;

/**
 * Blank out string and comment contents so brace counting cannot be fooled by
 * them. Length is preserved so indices stay aligned with the original line.
 * State carries across lines for block comments and template literals.
 */
function maskLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state === 'block') {
      if (ch === '*' && next === '/') { out += '  '; state = 'code'; i += 2; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'template') {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === '`') { out += '`'; state = 'code'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    // state === 'code'
    if (ch === '/' && next === '/') { out += ' '.repeat(line.length - i); break; }
    if (ch === '/' && next === '*') { out += '  '; state = 'block'; i += 2; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote; i += 1;
      while (i < line.length) {
        const c = line[i];
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === quote) { out += quote; i += 1; break; }
        out += ' '; i += 1;
      }
      continue;
    }
    if (ch === '`') { out += '`'; state = 'template'; i += 1; continue; }
    out += ch; i += 1;
  }
  return { masked: out, state };
}

/** Mask a whole file once; returns one masked line per source line. */
function maskFile(content, lang) {
  const lines = content.split('\n');
  let state = 'code';
  const masked = new Array(lines.length);
  if (lang === 'python') {
    // Python only needs docstrings and comments removed.
    let triple = null;
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n];
      if (triple) {
        const end = line.indexOf(triple);
        if (end === -1) { masked[n] = ''; continue; }
        triple = null;
        masked[n] = ' '.repeat(end + 3) + line.slice(end + 3);
        continue;
      }
      const hash = line.indexOf('#');
      const cut = hash === -1 ? line : line.slice(0, hash);
      const open = cut.search(/("""|''')/);
      if (open !== -1) {
        triple = cut.slice(open, open + 3);
        const close = cut.indexOf(triple, open + 3);
        masked[n] = close === -1 ? cut.slice(0, open) : cut;
        if (close !== -1) triple = null;
        continue;
      }
      masked[n] = cut;
    }
    return masked;
  }
  for (let n = 0; n < lines.length; n += 1) {
    const result = maskLine(lines[n], state);
    state = result.state;
    masked[n] = result.masked;
  }
  return masked;
}

function headerName(line, lang) {
  const patterns = lang === 'go' ? [BRACE_HEADERS[3]]
    : lang === 'rust' ? [BRACE_HEADERS[4]]
      : BRACE_HEADERS.slice(0, 3);
  for (const re of patterns) {
    const m = re.exec(line);
    if (m && m[1] && !KEYWORD_NAMES.has(m[1])) return m[1];
  }
  return undefined;
}

function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 8;
    else break;
  }
  return n;
}

function scanBrace(masked) {
  const found = [];
  const stack = [];
  let depth = 0;
  let pending;
  for (let n = 0; n < masked.length; n += 1) {
    const line = masked[n];
    const name = headerName(line);
    // A signature may span many lines (generics, long parameter or return
    // types), so the opening brace is allowed to arrive much later. It is given
    // up only on a statement terminator, a competing header, or a long gap.
    if (name !== undefined) pending = { name, line: n };
    else if (pending !== undefined && n - pending.line > 40) pending = undefined;
    else if (pending !== undefined && n > pending.line && STATEMENT_START.test(line)) pending = undefined;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '{') {
        depth += 1;
        if (pending !== undefined) {
          stack.push({ name: pending.name, startLine: pending.line, depth });
          pending = undefined;
        }
      } else if (ch === '}') {
        const top = stack[stack.length - 1];
        if (top !== undefined && top.depth === depth) {
          stack.pop();
          found.push({ name: top.name, startLine: top.startLine + 1, lines: n - top.startLine + 1 });
        }
        depth -= 1;
      } else if (ch === ';' && pending !== undefined && stack.length === 0) {
        pending = undefined;
      }
    }
  }
  return found;
}

function scanIndent(masked) {
  const found = [];
  const stack = [];
  for (let n = 0; n < masked.length; n += 1) {
    const line = masked[n];
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const m = PYTHON_HEADER.exec(line);
    if (m) {
      stack.push({ name: m[1], startLine: n, indent, last: n });
      continue;
    }
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      const frame = stack.pop();
      found.push({ name: frame.name, startLine: frame.startLine + 1, lines: frame.last - frame.startLine + 1 });
    }
    if (stack.length > 0) stack[stack.length - 1].last = n;
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    found.push({ name: frame.name, startLine: frame.startLine + 1, lines: frame.last - frame.startLine + 1 });
  }
  return found;
}

/**
 * Every function body in one file, as `{ name, startLine, lines }`.
 * Returns an empty array for languages this scanner does not know.
 */
export function scanFunctions(content, lang) {
  if (typeof content !== 'string' || content.length === 0) return [];
  if (BRACE_LANGS.has(lang)) return scanBrace(maskFile(content, lang));
  if (INDENT_LANGS.has(lang)) return scanIndent(maskFile(content, 'python'));
  return [];
}

export const FUNCTION_LANGS = new Set([...BRACE_LANGS, ...INDENT_LANGS]);
