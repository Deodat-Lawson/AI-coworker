/**
 * The markdown engine.
 *
 * Two jobs, one parser. Reading view renders a whole document; Live Preview
 * renders every block *except* the one holding the cursor, which stays as
 * editable source. Both need the same thing — blocks that know which source
 * lines they came from — so the parser is line-addressed throughout and every
 * rendered element carries `data-l` (line) and `data-o` (column) so a click on
 * rendered text maps back to a caret position in the source.
 */

import katex from 'katex';

import { highlight } from './highlight.js';

import { parseYaml, type FrontmatterValue } from '@ai-coworker/shared';

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface BlockBase {
  /** Absolute line numbers, inclusive of `from`, exclusive of `to`. */
  from: number;
  to: number;
}

export interface ListItem {
  line: number;
  indent: number;
  marker: string;
  ordered: boolean;
  /** ' ' unchecked, 'x' done, or any other single character Obsidian allows. */
  task?: string;
  content: string;
  /** Nested list items. */
  children: ListItem[];
  /** Continuation content indented under this item — paragraphs, code, quotes. */
  blocks: Block[];
}

export type Block =
  | (BlockBase & { type: 'frontmatter'; data: Record<string, FrontmatterValue>; raw: string })
  | (BlockBase & { type: 'heading'; level: number; text: string; slug: string })
  | (BlockBase & { type: 'paragraph'; lines: string[] })
  | (BlockBase & { type: 'code'; lang: string; code: string; fence: string })
  | (BlockBase & { type: 'math'; tex: string })
  | (BlockBase & {
      type: 'table';
      header: string[];
      align: ('left' | 'center' | 'right' | null)[];
      rows: string[][];
    })
  | (BlockBase & { type: 'list'; ordered: boolean; start: number; items: ListItem[] })
  | (BlockBase & {
      type: 'quote';
      callout?: { kind: string; title: string; fold: '' | '+' | '-' };
      children: Block[];
    })
  | (BlockBase & { type: 'hr' })
  | (BlockBase & { type: 'html'; html: string })
  | (BlockBase & { type: 'footnote'; label: string; children: Block[] })
  | (BlockBase & { type: 'comment'; text: string })
  | (BlockBase & { type: 'blank' });

export interface RenderContext {
  sourcePath: string;
  /** Vault path for a link target, or undefined when the note does not exist. */
  resolve(target: string, from: string): string | undefined;
  /** A URL the renderer can put in src=. */
  resourceUrl(path: string): string;
  /** Raw text of another note, for transclusion. Null while it is still loading. */
  readFile(path: string): string | null;
  strictLineBreaks?: boolean;
  /** Guards against a note embedding itself, directly or in a cycle. */
  depth?: number;
  /** Set while rendering an embed so nested UI (checkboxes) stays read-only. */
  embedded?: boolean;
}

const CALLOUT_ALIASES: Record<string, string> = {
  note: 'note', abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info', todo: 'todo', tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger', bug: 'bug',
  example: 'example', quote: 'quote', cite: 'quote',
};

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', abstract: '≡', info: 'i', todo: '☑', tip: '✦', success: '✓', question: '?',
  warning: '!', failure: '✗', danger: '⚡', bug: '🐞', example: '❋', quote: '❝',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseBlocks(lines: string[], from = 0): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  // Frontmatter, only at the very top of a document.
  if (from === 0 && lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let end = 1;
    while (end < lines.length && !/^---\s*$/.test(lines[end]!)) end += 1;
    if (end < lines.length) {
      const raw = lines.slice(1, end).join('\n');
      blocks.push({
        type: 'frontmatter',
        from,
        to: from + end + 1,
        raw,
        data: {},
      });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const absolute = from + i;

    if (!line.trim()) {
      const start = i;
      while (i < lines.length && !lines[i]!.trim()) i += 1;
      blocks.push({ type: 'blank', from: from + start, to: from + i });
      continue;
    }

    // Fenced code, including ```mermaid and ```math.
    const fence = /^(\s{0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const lang = fence[3]!.trim();
      let end = i + 1;
      while (end < lines.length) {
        const candidate = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[end]!);
        if (candidate && candidate[1]![0] === marker[0] && candidate[1]!.length >= marker.length) break;
        end += 1;
      }
      blocks.push({
        type: 'code',
        from: absolute,
        to: from + Math.min(end + 1, lines.length),
        lang,
        fence: marker,
        code: lines.slice(i + 1, end).join('\n'),
      });
      i = Math.min(end + 1, lines.length);
      continue;
    }

    // Display math.
    if (/^\s*\$\$/.test(line)) {
      const single = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (single) {
        blocks.push({ type: 'math', from: absolute, to: absolute + 1, tex: single[1]!.trim() });
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < lines.length && !/\$\$\s*$/.test(lines[end]!)) end += 1;
      blocks.push({
        type: 'math',
        from: absolute,
        to: from + Math.min(end + 1, lines.length),
        tex: lines.slice(i + 1, end).join('\n').replace(/\$\$\s*$/, ''),
      });
      i = Math.min(end + 1, lines.length);
      continue;
    }

    // %% comment %%
    if (/^\s*%%/.test(line)) {
      let end = i;
      if (!/%%\s*$/.test(line.trim().slice(2)) || line.trim() === '%%') {
        end = i + 1;
        while (end < lines.length && !/%%/.test(lines[end]!)) end += 1;
        end = Math.min(end + 1, lines.length);
      } else {
        end = i + 1;
      }
      blocks.push({
        type: 'comment',
        from: absolute,
        to: from + end,
        text: lines.slice(i, end).join('\n'),
      });
      i = end;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2]!.replace(/\s+#+\s*$/, '').trim();
      blocks.push({
        type: 'heading',
        from: absolute,
        to: absolute + 1,
        level: heading[1]!.length,
        text,
        slug: text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'),
      });
      i += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'hr', from: absolute, to: absolute + 1 });
      i += 1;
      continue;
    }

    // Footnote definition.
    const footnote = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      let end = i + 1;
      while (end < lines.length && /^(\s{2,}|\t)/.test(lines[end]!) && lines[end]!.trim()) end += 1;
      const body = [footnote[2]!, ...lines.slice(i + 1, end).map((l) => l.trim())];
      blocks.push({
        type: 'footnote',
        from: absolute,
        to: from + end,
        label: footnote[1]!,
        children: parseBlocks(body, absolute),
      });
      i = end;
      continue;
    }

    // Blockquote / callout.
    if (/^\s{0,3}>/.test(line)) {
      let end = i;
      const inner: string[] = [];
      while (end < lines.length && (/^\s{0,3}>/.test(lines[end]!) || (inner.length > 0 && lines[end]!.trim() !== ''))) {
        if (!/^\s{0,3}>/.test(lines[end]!)) break;
        inner.push(lines[end]!.replace(/^\s{0,3}>\s?/, ''));
        end += 1;
      }
      const calloutMatch = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(inner[0] ?? '');
      let callout: { kind: string; title: string; fold: '' | '+' | '-' } | undefined;
      let body = inner;
      if (calloutMatch) {
        const kind = CALLOUT_ALIASES[calloutMatch[1]!.toLowerCase()] ?? calloutMatch[1]!.toLowerCase();
        callout = {
          kind,
          title: calloutMatch[3]!.trim() || titleCase(calloutMatch[1]!),
          fold: (calloutMatch[2] as '' | '+' | '-') || '',
        };
        body = inner.slice(1);
      }
      blocks.push({
        type: 'quote',
        from: absolute,
        to: from + end,
        callout,
        children: parseBlocks(body, absolute + (callout ? 1 : 0)),
      });
      i = end;
      continue;
    }

    // Table: a header row followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center' as const;
        if (right) return 'right' as const;
        if (left) return 'left' as const;
        return null;
      });
      let end = i + 2;
      const rows: string[][] = [];
      while (end < lines.length && lines[end]!.includes('|') && lines[end]!.trim()) {
        rows.push(splitRow(lines[end]!));
        end += 1;
      }
      blocks.push({ type: 'table', from: absolute, to: from + end, header, align, rows });
      i = end;
      continue;
    }

    // Lists.
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      const start = i;
      const raw: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        if (!current.trim()) {
          // A single blank line inside a list keeps the list going.
          const next = lines[i + 1];
          if (next && /^(\s*)([-*+]|\d+[.)])\s+/.test(next)) {
            raw.push(current);
            i += 1;
            continue;
          }
          break;
        }
        if (!/^(\s*)([-*+]|\d+[.)])\s+/.test(current) && !/^\s{2,}\S/.test(current) && i > start) break;
        raw.push(current);
        i += 1;
      }
      const ordered = /^\s*\d+[.)]\s/.test(lines[start]!);
      const startNumber = ordered ? Number(/^\s*(\d+)/.exec(lines[start]!)![1]) : 1;
      blocks.push({
        type: 'list',
        from: from + start,
        to: from + i,
        ordered,
        start: startNumber,
        items: parseListItems(raw, from + start),
      });
      continue;
    }

    // Raw HTML block.
    if (/^\s{0,3}<(\/?[a-zA-Z][\w-]*)/.test(line) && !/^\s*<(https?:|[\w.+-]+@)/.test(line)) {
      let end = i;
      while (end < lines.length && lines[end]!.trim()) end += 1;
      blocks.push({
        type: 'html',
        from: absolute,
        to: from + end,
        html: lines.slice(i, end).join('\n'),
      });
      i = end;
      continue;
    }

    // Paragraph: everything up to a blank line or a line that starts a new block.
    const start = i;
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim()) {
      if (i > start && startsNewBlock(lines[i]!, lines[i + 1])) break;
      paragraph.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', from: from + start, to: from + i, lines: paragraph });
  }

  return blocks;
}

function startsNewBlock(line: string, next: string | undefined): boolean {
  return (
    /^(#{1,6})\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line) ||
    /^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*\$\$/.test(line) ||
    (line.includes('|') && next !== undefined && /^[\s|:-]+$/.test(next) && next.includes('-'))
  );
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Turn the raw lines of a list into a tree.
 *
 * Indentation drives nesting: a stack of open lists, each remembering the
 * column its items start at. Anything indented under an item that is not itself
 * a list item is continuation content and gets parsed as blocks, so a code
 * fence or a paragraph inside a bullet works.
 */
function parseListItems(lines: string[], from: number): ListItem[] {
  const root: ListItem[] = [];
  const stack: { indent: number; items: ListItem[] }[] = [{ indent: -1, items: root }];
  let current: ListItem | null = null;
  let continuation: string[] = [];
  let continuationStart = from;

  const flush = () => {
    if (current && continuation.some((l) => l.trim())) {
      while (continuation.length && !continuation[continuation.length - 1]!.trim()) continuation.pop();
      current.blocks = parseBlocks(dedent(continuation), continuationStart);
    }
    continuation = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);

    if (match) {
      flush();
      const indent = match[1]!.length;
      let content = match[3]!;
      let task: string | undefined;
      const taskMatch = /^\[(.)\]\s+(.*)$/.exec(content) ?? /^\[(.)\]$/.exec(content);
      if (taskMatch) {
        task = taskMatch[1]!;
        content = taskMatch[2] ?? '';
      }
      const item: ListItem = {
        line: from + i,
        indent,
        marker: match[2]!,
        ordered: /\d/.test(match[2]!),
        task,
        content,
        children: [],
        blocks: [],
      };

      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
      let top = stack[stack.length - 1]!;
      if (top.indent === -1) top.indent = indent;
      if (indent > top.indent) {
        const parent = top.items[top.items.length - 1];
        if (parent) {
          stack.push({ indent, items: parent.children });
          top = stack[stack.length - 1]!;
        }
      }
      top.items.push(item);
      current = item;
      continuationStart = from + i + 1;
      continue;
    }

    if (current) continuation.push(line);
  }
  flush();
  return root;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderMarkdown(source: string, ctx: RenderContext): string {
  return renderBlocks(parseBlocks(source.split('\n')), ctx);
}

export function renderBlocks(blocks: Block[], ctx: RenderContext): string {
  return blocks.map((block) => renderBlock(block, ctx)).join('');
}

export function renderBlock(block: Block, ctx: RenderContext): string {
  switch (block.type) {
    case 'blank':
      return '';
    case 'comment':
      return `<div class="md-comment" data-l="${block.from}">${escapeHtml(block.text)}</div>`;
    case 'frontmatter':
      return renderFrontmatter(block.raw, block.from);
    case 'heading': {
      const inner = renderInline(block.text, ctx, block.from, block.level + 1);
      return `<h${block.level} class="md-h" id="${escapeHtml(block.slug)}" data-l="${block.from}">${inner}</h${block.level}>`;
    }
    case 'hr':
      return `<hr data-l="${block.from}" />`;
    case 'html':
      return `<div class="md-html" data-l="${block.from}">${block.html}</div>`;
    case 'code':
      return renderCode(block.lang, block.code, block.from);
    case 'math':
      return `<div class="md-math-block" data-l="${block.from}">${renderMath(block.tex, true)}</div>`;
    case 'table':
      return renderTable(block, ctx);
    case 'list':
      return renderList(block, ctx);
    case 'quote':
      return renderQuote(block, ctx);
    case 'footnote':
      return `<div class="md-footnote" id="fn-${escapeHtml(block.label)}" data-l="${block.from}"><span class="md-footnote-label">${escapeHtml(block.label)}.</span> ${renderBlocks(block.children, ctx)}</div>`;
    case 'paragraph':
      return renderParagraph(block.lines, block.from, ctx);
  }
}

function renderFrontmatter(raw: string, line: number): string {
  const data = parseYaml(raw);
  const keys = Object.keys(data);
  if (keys.length === 0) return '';
  const rows = keys
    .map((key) => {
      const value = data[key];
      const rendered = Array.isArray(value)
        ? value
            .map((entry) => `<span class="prop-chip">${escapeHtml(formatProperty(entry))}</span>`)
            .join('')
        : escapeHtml(formatProperty(value ?? null));
      return `<div class="prop-row"><div class="prop-key">${escapeHtml(key)}</div><div class="prop-value">${rendered}</div></div>`;
    })
    .join('');
  return `<div class="md-frontmatter" data-l="${line}"><div class="prop-title">Properties</div>${rows}</div>`;
}

function formatProperty(value: FrontmatterValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => formatProperty(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderCode(lang: string, code: string, line: number): string {
  const language = lang.split(/\s+/)[0] ?? '';
  if (language === 'mermaid') {
    return `<div class="md-mermaid" data-l="${line}" data-code="${escapeHtml(code)}"><pre class="mermaid-source">${escapeHtml(code)}</pre></div>`;
  }
  if (language === 'math' || language === 'latex') {
    return `<div class="md-math-block" data-l="${line}">${renderMath(code, true)}</div>`;
  }
  const label = language ? `<span class="md-code-lang">${escapeHtml(language)}</span>` : '';
  return `<div class="md-code" data-l="${line}">${label}<button class="md-copy" data-copy="${escapeHtml(code)}" type="button">Copy</button><pre><code class="language-${escapeHtml(language)}">${highlight(code, language)}</code></pre></div>`;
}

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      trust: false,
    });
  } catch (err) {
    return `<span class="md-math-error" title="${escapeHtml((err as Error).message)}">${escapeHtml(tex)}</span>`;
  }
}

function renderTable(
  block: Extract<Block, { type: 'table' }>,
  ctx: RenderContext,
): string {
  const head = block.header
    .map((cell, i) => `<th${alignAttr(block.align[i])}>${renderInline(cell, ctx, block.from, 0)}</th>`)
    .join('');
  const body = block.rows
    .map(
      (row, r) =>
        `<tr>${block.header
          .map(
            (_h, i) =>
              `<td${alignAttr(block.align[i])}>${renderInline(row[i] ?? '', ctx, block.from + 2 + r, 0)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="md-table-wrap" data-l="${block.from}"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function alignAttr(align: 'left' | 'center' | 'right' | null | undefined): string {
  return align ? ` style="text-align:${align}"` : '';
}

function renderList(block: Extract<Block, { type: 'list' }>, ctx: RenderContext): string {
  return renderItems(block.items, block.start, ctx);
}

function renderItems(items: ListItem[], start: number, ctx: RenderContext): string {
  if (!items.length) return '';
  const ordered = items[0]!.ordered;
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
  const body = items
    .map((item) => {
      const checkbox =
        item.task !== undefined
          ? `<input class="md-task" type="checkbox" data-task-line="${item.line}"${item.task !== ' ' ? ' checked' : ''}${ctx.embedded ? ' disabled' : ''} />`
          : '';
      const classes = ['md-li'];
      if (item.task !== undefined) classes.push('md-task-item');
      if (item.task !== undefined && item.task !== ' ') classes.push('is-done');
      // Column the item's text starts at, so a click lands on the right character.
      const column = item.indent + item.marker.length + 1 + (item.task !== undefined ? 4 : 0);
      const nested = item.children.length
        ? renderItems(item.children, item.children[0]!.ordered ? 1 : 1, ctx)
        : '';
      return `<li class="${classes.join(' ')}" data-l="${item.line}" data-status="${escapeHtml(item.task ?? '')}">${checkbox}<span class="md-li-body">${renderInline(item.content, ctx, item.line, column)}</span>${renderBlocks(item.blocks, ctx)}${nested}</li>`;
    })
    .join('');
  return `<${tag} class="md-list"${startAttr}>${body}</${tag}>`;
}

function renderQuote(block: Extract<Block, { type: 'quote' }>, ctx: RenderContext): string {
  const inner = renderBlocks(block.children, ctx);
  if (!block.callout) {
    return `<blockquote class="md-quote" data-l="${block.from}">${inner}</blockquote>`;
  }
  const { kind, title, fold } = block.callout;
  const icon = CALLOUT_ICONS[kind] ?? '•';
  const foldable = fold ? ' is-foldable' : '';
  const collapsed = fold === '-' ? ' is-collapsed' : '';
  const foldIcon = fold ? '<span class="md-callout-fold">▾</span>' : '';
  // Deliberately one line: this HTML is injected into the editor surface, and
  // stray whitespace between blocks would render as blank space there.
  return `<div class="md-callout callout-${escapeHtml(kind)}${foldable}${collapsed}" data-l="${block.from}" data-callout="${escapeHtml(kind)}"><div class="md-callout-title"><span class="md-callout-icon">${icon}</span><span class="md-callout-text">${renderInline(title, ctx, block.from, 0)}</span>${foldIcon}</div><div class="md-callout-body">${inner}</div></div>`;
}

function renderParagraph(lines: string[], from: number, ctx: RenderContext): string {
  // A paragraph that is only an embed becomes the embedded content itself —
  // an image, a video, a PDF or a transcluded note, decided the same way an
  // inline embed decides it.
  if (lines.length === 1) {
    const only = /^\s*!\[\[([^\]]+)\]\]\s*$/.exec(lines[0]!);
    if (only) return renderInlineEmbed(only[1]!, ctx, from, lines[0]!.indexOf('!'));
  }
  const html = lines
    .map((line, i) => renderInline(line, ctx, from + i, 0))
    .join(ctx.strictLineBreaks ? ' ' : '<br />');
  return `<p class="md-p" data-l="${from}">${html}</p>`;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * Render one source line. `base` is the column `text` starts at, so every
 * emitted span can carry a real source column for click-to-caret mapping.
 */
export function renderInline(text: string, ctx: RenderContext, line: number, base = 0): string {
  let out = '';
  let i = 0;
  let plain = '';
  let plainStart = 0;

  const flush = () => {
    if (!plain) return;
    out += `<span data-l="${line}" data-o="${base + plainStart}">${escapeHtml(plain)}</span>`;
    plain = '';
  };
  const at = (n: number) => base + n;

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i]!;

    // Escapes.
    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~=$<>]/.test(text[i + 1]!)) {
      if (!plain) plainStart = i;
      plain += text[i + 1]!;
      i += 2;
      continue;
    }

    // Inline code — highest precedence, so nothing inside it is parsed.
    if (ch === '`') {
      const fence = /^`+/.exec(rest)![0];
      const close = text.indexOf(fence, i + fence.length);
      if (close !== -1) {
        flush();
        const code = text.slice(i + fence.length, close);
        out += `<code class="md-code-inline" data-l="${line}" data-o="${at(i)}">${escapeHtml(code)}</code>`;
        i = close + fence.length;
        continue;
      }
    }

    // Inline math.
    if (ch === '$' && rest[1] !== '$') {
      const close = findClosing(text, i + 1, '$');
      if (close !== -1 && close > i + 1) {
        flush();
        out += `<span class="md-math-inline" data-l="${line}" data-o="${at(i)}">${renderMath(text.slice(i + 1, close), false)}</span>`;
        i = close + 1;
        continue;
      }
    }

    // Embeds and wikilinks.
    if (rest.startsWith('![[') || rest.startsWith('[[')) {
      const embed = rest.startsWith('!');
      const open = embed ? 3 : 2;
      const close = text.indexOf(']]', i + open);
      if (close !== -1) {
        flush();
        const inner = text.slice(i + open, close);
        out += embed
          ? renderInlineEmbed(inner, ctx, line, at(i))
          : renderWikilink(inner, ctx, line, at(i));
        i = close + 2;
        continue;
      }
    }

    // Images and links.
    if (ch === '[' || (ch === '!' && rest[1] === '[')) {
      const isImage = ch === '!';
      const labelStart = i + (isImage ? 2 : 1);
      const labelEnd = matchBracket(text, labelStart - 1, '[', ']');
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const urlEnd = matchBracket(text, labelEnd + 1, '(', ')');
        if (urlEnd !== -1) {
          flush();
          const label = text.slice(labelStart, labelEnd);
          const target = text.slice(labelEnd + 2, urlEnd).trim();
          out += renderMarkdownLink(label, target, isImage, ctx, line, at(i));
          i = urlEnd + 1;
          continue;
        }
      }
      // Footnote reference.
      const footnote = /^\[\^([^\]]+)\]/.exec(rest);
      if (footnote) {
        flush();
        out += `<sup class="md-footnote-ref" data-l="${line}" data-o="${at(i)}"><a href="#fn-${escapeHtml(footnote[1]!)}" data-footnote="${escapeHtml(footnote[1]!)}">${escapeHtml(footnote[1]!)}</a></sup>`;
        i += footnote[0].length;
        continue;
      }
    }

    // Autolinks and bare URLs.
    const autolink = /^<((?:https?|mailto|obsidian):[^>\s]+)>/.exec(rest);
    if (autolink) {
      flush();
      out += externalAnchor(autolink[1]!, autolink[1]!, line, at(i));
      i += autolink[0].length;
      continue;
    }
    const bare = /^(https?:\/\/[^\s<>()[\]"']+)/.exec(rest);
    if (bare && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      flush();
      out += externalAnchor(bare[1]!, bare[1]!, line, at(i));
      i += bare[0].length;
      continue;
    }

    // Emphasis and friends, longest marker first.
    const delimiters: [string, (inner: string, from: number) => string][] = [
      ['***', (inner, from) => `<strong><em>${renderInline(inner, ctx, line, from)}</em></strong>`],
      ['___', (inner, from) => `<strong><em>${renderInline(inner, ctx, line, from)}</em></strong>`],
      ['**', (inner, from) => `<strong>${renderInline(inner, ctx, line, from)}</strong>`],
      ['__', (inner, from) => `<strong>${renderInline(inner, ctx, line, from)}</strong>`],
      ['~~', (inner, from) => `<del>${renderInline(inner, ctx, line, from)}</del>`],
      ['==', (inner, from) => `<mark>${renderInline(inner, ctx, line, from)}</mark>`],
    ];
    let matched = false;
    for (const [marker, wrap] of delimiters) {
      if (!rest.startsWith(marker)) continue;
      const close = text.indexOf(marker, i + marker.length);
      if (close === -1) continue;
      flush();
      out += wrap(text.slice(i + marker.length, close), at(i + marker.length));
      i = close + marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    if ((ch === '*' || ch === '_') && text[i + 1] !== ch) {
      // `_` only opens emphasis at a word boundary, so snake_case survives.
      const boundaryOk = ch === '*' || i === 0 || /[\s(["']/.test(text[i - 1]!);
      const close = boundaryOk ? text.indexOf(ch, i + 1) : -1;
      if (close > i + 1 && !/\s/.test(text[i + 1]!)) {
        flush();
        out += `<em>${renderInline(text.slice(i + 1, close), ctx, line, at(i + 1))}</em>`;
        i = close + 1;
        continue;
      }
    }

    // Tags.
    if (ch === '#' && (i === 0 || /[\s([>]/.test(text[i - 1]!))) {
      const tag = /^#([\p{L}\p{N}_/-]*[\p{L}\p{N}_/-])/u.exec(rest);
      if (tag && !/^\d+$/.test(tag[1]!)) {
        flush();
        out += `<a class="md-tag" data-tag="${escapeHtml(tag[1]!)}" data-l="${line}" data-o="${at(i)}">#${escapeHtml(tag[1]!)}</a>`;
        i += tag[0].length;
        continue;
      }
    }

    // Block identifier at end of line.
    if (ch === '^' && /^\^[\w-]+\s*$/.test(rest) && i > 0 && /\s/.test(text[i - 1]!)) {
      flush();
      out += `<span class="md-block-id" data-l="${line}" data-o="${at(i)}">${escapeHtml(rest.trim())}</span>`;
      i = text.length;
      continue;
    }

    // Pass through inline HTML that looks intentional.
    if (ch === '<' && /^<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/.test(rest)) {
      const tag = /^<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/.exec(rest)!;
      flush();
      out += tag[0];
      i += tag[0].length;
      continue;
    }

    if (!plain) plainStart = i;
    plain += ch;
    i += 1;
  }
  flush();
  return out || `<span data-l="${line}" data-o="${base}"></span>`;
}

function findClosing(text: string, from: number, marker: string): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === marker) return i;
  }
  return -1;
}

function matchBracket(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function externalAnchor(href: string, label: string, line: number, col: number): string {
  return `<a class="md-external" href="${escapeHtml(href)}" data-external="${escapeHtml(href)}" data-l="${line}" data-o="${col}">${escapeHtml(label)}</a>`;
}

function splitTarget(raw: string): { target: string; subpath: string; alias?: string } {
  let rest = raw;
  let alias: string | undefined;
  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe);
  }
  let subpath = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    subpath = rest.slice(hash);
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), subpath, alias };
}

function renderWikilink(raw: string, ctx: RenderContext, line: number, col: number): string {
  const { target, subpath, alias } = splitTarget(raw);
  const resolved = target ? ctx.resolve(target, ctx.sourcePath) : ctx.sourcePath;
  const label = alias || `${target}${subpath ? ` ${subpath.replace(/^#\^?/, '› ')}` : ''}` || subpath.replace(/^#/, '');
  const cls = resolved ? 'md-link' : 'md-link is-unresolved';
  return `<a class="${cls}" data-href="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}" data-resolved="${escapeHtml(resolved ?? '')}" data-l="${line}" data-o="${col}">${escapeHtml(label)}</a>`;
}

function renderMarkdownLink(
  label: string,
  target: string,
  isImage: boolean,
  ctx: RenderContext,
  line: number,
  col: number,
): string {
  const href = target.replace(/^<|>$/g, '').split(/\s+"/)[0]!.trim();
  const external = /^[a-z][\w+.-]*:/i.test(href);
  if (isImage) {
    const src = external ? href : ctx.resourceUrl(ctx.resolve(decodeURI(href), ctx.sourcePath) ?? decodeURI(href));
    return `<img class="md-image" src="${escapeHtml(src)}" alt="${escapeHtml(label)}" data-l="${line}" data-o="${col}" />`;
  }
  if (external) return externalAnchor(href, label || href, line, col);
  const { target: file, subpath } = splitTarget(decodeURI(href));
  const resolved = file ? ctx.resolve(file, ctx.sourcePath) : ctx.sourcePath;
  const cls = resolved ? 'md-link' : 'md-link is-unresolved';
  return `<a class="${cls}" data-href="${escapeHtml(file)}" data-subpath="${escapeHtml(subpath)}" data-resolved="${escapeHtml(resolved ?? '')}" data-l="${line}" data-o="${col}">${escapeHtml(label || file)}</a>`;
}

function renderInlineEmbed(raw: string, ctx: RenderContext, line: number, col: number): string {
  const { target, subpath, alias } = splitTarget(raw);
  const resolved = ctx.resolve(target, ctx.sourcePath);
  const extension = (resolved ?? target).split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'].includes(extension)) {
    // ![[image.png|300]] and ![[image.png|300x200]] set the display size.
    const size = alias && /^\d+(x\d+)?$/.test(alias) ? alias.split('x') : null;
    const style = size
      ? ` style="width:${size[0]}px${size[1] ? `;height:${size[1]}px` : ''}"`
      : '';
    return `<img class="md-image" src="${escapeHtml(ctx.resourceUrl(resolved ?? target))}" alt="${escapeHtml(alias ?? target)}"${style} data-l="${line}" data-o="${col}" />`;
  }
  if (['mp4', 'webm', 'ogv', 'mov'].includes(extension)) {
    return `<video class="md-video" controls src="${escapeHtml(ctx.resourceUrl(resolved ?? target))}" data-l="${line}"></video>`;
  }
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(extension)) {
    return `<audio class="md-audio" controls src="${escapeHtml(ctx.resourceUrl(resolved ?? target))}" data-l="${line}"></audio>`;
  }
  if (extension === 'pdf') {
    return `<iframe class="md-pdf" src="${escapeHtml(ctx.resourceUrl(resolved ?? target))}" data-l="${line}"></iframe>`;
  }
  return renderEmbed(raw, ctx, line);
}

/** Transclusion: pull another note (or one of its sections) into this one. */
export function renderEmbed(raw: string, ctx: RenderContext, line: number): string {
  const { target, subpath } = splitTarget(raw);
  const depth = ctx.depth ?? 0;
  const resolved = target ? ctx.resolve(target, ctx.sourcePath) : ctx.sourcePath;
  if (!resolved) {
    return `<div class="md-embed is-unresolved" data-l="${line}">Nothing here yet — <a class="md-link is-unresolved" data-href="${escapeHtml(target)}" data-resolved="">${escapeHtml(target)}</a></div>`;
  }
  if (depth >= 4 || resolved === ctx.sourcePath) {
    return `<div class="md-embed is-cyclic" data-l="${line}">↻ ${escapeHtml(target)}</div>`;
  }
  const content = ctx.readFile(resolved);
  if (content === null) {
    return `<div class="md-embed is-loading" data-l="${line}" data-embed="${escapeHtml(resolved)}">Loading ${escapeHtml(target)}…</div>`;
  }
  const section = extractSection(content, subpath);
  const inner = renderMarkdown(section, {
    ...ctx,
    sourcePath: resolved,
    depth: depth + 1,
    embedded: true,
  });
  return `<div class="md-embed" data-l="${line}" data-embed="${escapeHtml(resolved)}"><div class="md-embed-title"><a class="md-link" data-href="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}" data-resolved="${escapeHtml(resolved)}">${escapeHtml(target)}${escapeHtml(subpath)}</a></div><div class="md-embed-body">${inner}</div></div>`;
}

/** The slice of a note a `#heading` or `#^block` subpath refers to. */
export function extractSection(content: string, subpath: string): string {
  if (!subpath) return content;
  const lines = content.split('\n');
  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2);
    const index = lines.findIndex((l) => new RegExp(`\\s\\^${escapeRegex(id)}\\s*$`).test(l));
    if (index === -1) return content;
    // A block is the paragraph the anchor sits at the end of.
    let start = index;
    while (start > 0 && lines[start - 1]!.trim()) start -= 1;
    return lines
      .slice(start, index + 1)
      .join('\n')
      .replace(/\s\^[\w-]+\s*$/, '');
  }
  const wanted = subpath.slice(1).toLowerCase().trim();
  const headingAt = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    return m ? m[2]!.trim().toLowerCase() === wanted : false;
  });
  if (headingAt === -1) return content;
  const level = /^(#{1,6})/.exec(lines[headingAt]!)![1]!.length;
  let end = headingAt + 1;
  while (end < lines.length) {
    const m = /^(#{1,6})\s/.exec(lines[end]!);
    if (m && m[1]!.length <= level) break;
    end += 1;
  }
  return lines.slice(headingAt, end).join('\n');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
