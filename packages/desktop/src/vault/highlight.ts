/**
 * Syntax highlighting for fenced code blocks.
 *
 * One tokenizer, driven by a per-language table of keywords and comment
 * markers. It is not a parser and does not try to be: in a note, the job is to
 * make a snippet readable at a glance, and a lexer does that for every language
 * anyone is likely to paste in.
 */

interface LanguageSpec {
  keywords: string[];
  types?: string[];
  literals?: string[];
  lineComment?: string[];
  blockComment?: [string, string];
  strings?: string[];
  /** Enables `#` comments and `'''` strings, etc. */
  flavour?: 'c' | 'python' | 'shell' | 'lisp' | 'html' | 'css' | 'json' | 'yaml' | 'diff';
}

const JS_KEYWORDS = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'async', 'await', 'of', 'from', 'as', 'get', 'set',
];

const TS_KEYWORDS = [
  ...JS_KEYWORDS, 'interface', 'type', 'enum', 'implements', 'declare', 'namespace', 'abstract',
  'public', 'private', 'protected', 'readonly', 'satisfies', 'keyof', 'infer', 'is', 'asserts',
];

const LANGUAGES: Record<string, LanguageSpec> = {
  javascript: { keywords: JS_KEYWORDS, literals: ['true', 'false', 'null', 'undefined', 'NaN'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  typescript: { keywords: TS_KEYWORDS, types: ['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint'], literals: ['true', 'false', 'null', 'undefined'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  json: { keywords: [], literals: ['true', 'false', 'null'], flavour: 'json' },
  python: { keywords: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'], literals: ['True', 'False', 'None', 'self', 'cls'], lineComment: ['#'], flavour: 'python' },
  bash: { keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'export', 'local', 'source', 'echo', 'cd', 'set', 'unset', 'in'], lineComment: ['#'], flavour: 'shell' },
  html: { keywords: [], flavour: 'html' },
  xml: { keywords: [], flavour: 'html' },
  css: { keywords: [], flavour: 'css' },
  sql: { keywords: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'create', 'table', 'alter', 'drop', 'index', 'view', 'and', 'or', 'not', 'null', 'as', 'distinct', 'union', 'all', 'case', 'when', 'then', 'end', 'with', 'returning'], lineComment: ['--'], blockComment: ['/*', '*/'], flavour: 'c' },
  go: { keywords: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'], types: ['string', 'int', 'int64', 'float64', 'bool', 'byte', 'rune', 'error', 'any'], literals: ['true', 'false', 'nil', 'iota'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  rust: { keywords: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where', 'while'], types: ['String', 'str', 'u8', 'u32', 'u64', 'i32', 'i64', 'f32', 'f64', 'bool', 'Vec', 'Option', 'Result'], literals: ['true', 'false', 'None', 'Some', 'Ok', 'Err'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  java: { keywords: ['abstract', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for', 'if', 'implements', 'import', 'instanceof', 'interface', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'record', 'var'], types: ['int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short', 'String'], literals: ['true', 'false', 'null'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  c: { keywords: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'include', 'define'], literals: ['NULL', 'true', 'false'], lineComment: ['//'], blockComment: ['/*', '*/'], flavour: 'c' },
  yaml: { keywords: [], literals: ['true', 'false', 'null', 'yes', 'no'], lineComment: ['#'], flavour: 'yaml' },
  diff: { keywords: [], flavour: 'diff' },
  ruby: { keywords: ['def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'do', 'begin', 'rescue', 'ensure', 'return', 'yield', 'require', 'attr_accessor', 'then', 'case', 'when'], literals: ['true', 'false', 'nil', 'self'], lineComment: ['#'], flavour: 'python' },
  php: { keywords: ['function', 'class', 'public', 'private', 'protected', 'return', 'if', 'else', 'elseif', 'foreach', 'for', 'while', 'echo', 'new', 'use', 'namespace', 'const', 'static', 'try', 'catch'], literals: ['true', 'false', 'null'], lineComment: ['//', '#'], blockComment: ['/*', '*/'], flavour: 'c' },
};

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  htm: 'html', svg: 'xml', vue: 'html',
  scss: 'css', less: 'css',
  yml: 'yaml',
  golang: 'go', rs: 'rust', kt: 'java', cpp: 'c', 'c++': 'c', h: 'c', cs: 'java',
  postgres: 'sql', psql: 'sql', mysql: 'sql',
  patch: 'diff',
  rb: 'ruby',
};

export function knownLanguage(lang: string): boolean {
  const key = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return key in LANGUAGES;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

export function highlight(code: string, lang: string): string {
  const key = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const spec = LANGUAGES[key];
  if (!spec) return escapeHtml(code);
  if (spec.flavour === 'diff') return highlightDiff(code);
  if (spec.flavour === 'html') return highlightMarkup(code);
  if (spec.flavour === 'css') return highlightCss(code);
  if (spec.flavour === 'yaml') return highlightYaml(code);
  return highlightGeneric(code, spec);
}

function highlightGeneric(code: string, spec: LanguageSpec): string {
  const keywords = new Set(spec.keywords);
  const types = new Set(spec.types ?? []);
  const literals = new Set(spec.literals ?? []);
  const lineComments = spec.lineComment ?? [];
  const blockOpen = spec.blockComment?.[0];
  const blockClose = spec.blockComment?.[1];
  let out = '';
  let i = 0;

  while (i < code.length) {
    const rest = code.slice(i);

    const lineComment = lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += span('comment', code.slice(i, stop));
      i = stop;
      continue;
    }

    if (blockOpen && blockClose && rest.startsWith(blockOpen)) {
      const end = code.indexOf(blockClose, i + blockOpen.length);
      const stop = end === -1 ? code.length : end + blockClose.length;
      out += span('comment', code.slice(i, stop));
      i = stop;
      continue;
    }

    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j += 1;
          break;
        }
        if (code[j] === '\n' && quote !== '`') break;
        j += 1;
      }
      out += span('string', code.slice(i, j));
      i = j;
      continue;
    }

    const number = /^0[xXbBoO][0-9a-fA-F_]+|^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      out += span('number', number[0]);
      i += number[0].length;
      continue;
    }

    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const text = word[0];
      const after = code.slice(i + text.length).match(/^\s*\(/);
      if (keywords.has(text)) out += span('keyword', text);
      else if (literals.has(text)) out += span('literal', text);
      else if (types.has(text)) out += span('type', text);
      else if (after) out += span('function', text);
      else if (/^[A-Z]/.test(text)) out += span('type', text);
      else out += escapeHtml(text);
      i += text.length;
      continue;
    }

    if (spec.flavour === 'python' && rest.startsWith('@')) {
      const decorator = /^@[\w.]+/.exec(rest)!;
      out += span('decorator', decorator[0]);
      i += decorator[0].length;
      continue;
    }
    if (spec.flavour === 'shell' && rest.startsWith('$')) {
      const variable = /^\$\{?[\w]+\}?/.exec(rest);
      if (variable) {
        out += span('variable', variable[0]);
        i += variable[0].length;
        continue;
      }
    }

    const punct = /^[{}()[\];,.:?!=<>+\-*/%&|^~]+/.exec(rest);
    if (punct) {
      out += span('punct', punct[0]);
      i += punct[0].length;
      continue;
    }

    out += escapeHtml(code[i]!);
    i += 1;
  }
  return out;
}

function highlightMarkup(code: string): string {
  return code.replace(/(<!--[\s\S]*?-->)|(<\/?)([\w:-]+)((?:[^<>"']|"[^"]*"|'[^']*')*)(\/?>)|([^<]+)/g,
    (_m, comment: string, open: string, name: string, attrs: string, close: string, text: string) => {
      if (comment) return span('comment', comment);
      if (text) return escapeHtml(text);
      const attrHtml = (attrs ?? '').replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g,
        (_a, key: string, eq: string, value: string) =>
          `${span('attr', key)}${escapeHtml(eq)}${value ? span('string', value) : ''}`);
      return `${span('punct', open)}${span('tag', name)}${attrHtml}${span('punct', close)}`;
    });
}

function highlightCss(code: string): string {
  return code.replace(/(\/\*[\s\S]*?\*\/)|([\w-]+)(\s*:\s*)([^;{}\n]+)|([.#]?[\w-]+)(?=[^{}]*\{)|(.)/g,
    (m, comment: string, prop: string, colon: string, value: string, selector: string, other: string) => {
      if (comment) return span('comment', comment);
      if (prop && colon) return `${span('attr', prop)}${escapeHtml(colon)}${span('string', value ?? '')}`;
      if (selector) return span('tag', selector);
      return escapeHtml(other ?? m);
    });
}

function highlightYaml(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return span('comment', line);
      const match = /^(\s*-?\s*)([\w.-]+)(\s*:\s*)(.*)$/.exec(line);
      if (!match) return escapeHtml(line);
      return `${escapeHtml(match[1]!)}${span('attr', match[2]!)}${escapeHtml(match[3]!)}${span('string', match[4]!)}`;
    })
    .join('\n');
}

function highlightDiff(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return span('added', line);
      if (line.startsWith('-')) return span('removed', line);
      if (line.startsWith('@@')) return span('meta', line);
      return escapeHtml(line);
    })
    .join('\n');
}
