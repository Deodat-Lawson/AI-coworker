/**
 * Source decoration for the editor.
 *
 * The one hard rule: the text content of the HTML this produces must equal the
 * source line, character for character. The editor serializes the DOM back to
 * markdown, so a decorator that swallows or invents a character would corrupt
 * the file. Everything here therefore only *wraps* — it never rewrites.
 */

import { escapeHtml } from './markdown.js';

function span(cls: string, text: string): string {
  return text ? `<span class="${cls}">${escapeHtml(text)}</span>` : '';
}

/** A malformed percent-escape must not throw mid-keystroke. */
function decodeUriSafe(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export interface DecorateOptions {
  /** True while the caret is on this line: markers stay fully visible. */
  active: boolean;
  /** Inside a fenced code block, only the code colouring applies. */
  inCode?: boolean;
  language?: string;
  /**
   * Resolves a link target to a vault path. Supplying it makes links in the
   * line you are editing navigable with the modifier held, and marks the ones
   * that point nowhere.
   */
  resolve?(target: string): string | undefined;
}

function attr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/** Split "Note#Heading|Alias" without touching the text. */
function linkParts(raw: string): { target: string; subpath: string } {
  const head = raw.includes('|') ? raw.slice(0, raw.indexOf('|')) : raw;
  const hash = head.indexOf('#');
  return {
    target: (hash === -1 ? head : head.slice(0, hash)).trim(),
    subpath: hash === -1 ? '' : head.slice(hash),
  };
}

export function decorateLine(text: string, options: DecorateOptions): string {
  if (!text) return '';

  if (options.inCode) {
    return span('cm-code-line', text);
  }

  // Line-level prefixes come first; the remainder is decorated inline.
  const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(text);
  if (fence) {
    return `${escapeHtml(fence[1]!)}${span('cm-formatting cm-fence', fence[2]!)}${span('cm-fence-lang', fence[3]!)}`;
  }

  if (/^\s*%%/.test(text)) return span('cm-comment', text);

  if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(text)) return span('cm-hr', text);

  const heading = /^(#{1,6})(\s+)(.*)$/.exec(text);
  if (heading) {
    const level = heading[1]!.length;
    return (
      span(`cm-formatting cm-formatting-header`, heading[1]!) +
      escapeHtml(heading[2]!) +
      `<span class="cm-header cm-header-${level}">${decorateInline(heading[3]!, options)}</span>`
    );
  }

  let prefix = '';
  let rest = text;

  const quote = /^(\s*(?:>\s?)+)/.exec(rest);
  if (quote) {
    prefix += span('cm-formatting cm-quote-marker', quote[1]!);
    rest = rest.slice(quote[1]!.length);
    const callout = /^(\[!)([\w-]+)(\][+-]?)(.*)$/.exec(rest);
    if (callout) {
      return `${prefix}${span('cm-formatting', callout[1]!)}${span('cm-callout-kind', callout[2]!)}${span('cm-formatting', callout[3]!)}${decorateInline(callout[4]!, options)}`;
    }
    return `${prefix}<span class="cm-quote">${decorateInline(rest, options)}</span>`;
  }

  const listItem = /^(\s*)([-*+]|\d+[.)])(\s+)(\[(.)\]\s+)?/.exec(rest);
  if (listItem && listItem[0]) {
    prefix += escapeHtml(listItem[1]!);
    prefix += span('cm-formatting cm-list-marker', listItem[2]!);
    prefix += escapeHtml(listItem[3]!);
    if (listItem[4]) {
      const done = listItem[5] !== ' ';
      prefix += span(`cm-checkbox ${done ? 'is-done' : ''}`, listItem[4]!);
      rest = rest.slice(listItem[0].length);
      return `${prefix}<span class="cm-task-text ${done ? 'is-done' : ''}">${decorateInline(rest, options)}</span>`;
    }
    rest = rest.slice(listItem[0].length);
    return `${prefix}${decorateInline(rest, options)}`;
  }

  const footnote = /^(\[\^[^\]]+\]:)(.*)$/.exec(rest);
  if (footnote) {
    return span('cm-formatting cm-link', footnote[1]!) + decorateInline(footnote[2]!, options);
  }

  return prefix + decorateInline(rest, options);
}

/**
 * Wrap inline markup. `cm-formatting` marks the syntax characters themselves —
 * the stylesheet dims them, and hides them entirely on inactive lines, which is
 * what makes Live Preview read like prose without changing a byte of the file.
 */
export function decorateInline(text: string, options: DecorateOptions): string {
  let out = '';
  let i = 0;
  let plain = '';

  const flush = () => {
    if (plain) out += escapeHtml(plain);
    plain = '';
  };
  const marker = (chars: string) =>
    `<span class="cm-formatting${options.active ? '' : ' cm-hidden'}">${escapeHtml(chars)}</span>`;

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i]!;

    if (ch === '\\' && i + 1 < text.length) {
      flush();
      out += marker('\\') + escapeHtml(text[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '`') {
      const ticks = /^`+/.exec(rest)![0];
      const close = text.indexOf(ticks, i + ticks.length);
      if (close !== -1) {
        flush();
        out += `${marker(ticks)}<span class="cm-inline-code">${escapeHtml(text.slice(i + ticks.length, close))}</span>${marker(ticks)}`;
        i = close + ticks.length;
        continue;
      }
    }

    if (ch === '$' && rest[1] !== '$') {
      const close = text.indexOf('$', i + 1);
      if (close > i + 1) {
        flush();
        out += `${marker('$')}<span class="cm-math">${escapeHtml(text.slice(i + 1, close))}</span>${marker('$')}`;
        i = close + 1;
        continue;
      }
    }

    if (rest.startsWith('![[') || rest.startsWith('[[')) {
      const embed = rest.startsWith('!');
      const open = embed ? '![[' : '[[';
      const close = text.indexOf(']]', i + open.length);
      if (close !== -1) {
        flush();
        const inner = text.slice(i + open.length, close);
        const { target, subpath } = linkParts(inner);
        const resolved = options.resolve ? (options.resolve(target) ?? '') : '';
        const unresolved = options.resolve && !resolved ? ' is-unresolved' : '';
        const data = options.resolve
          ? ` data-href="${attr(target)}" data-subpath="${attr(subpath)}" data-resolved="${attr(resolved)}"`
          : '';
        out += `${marker(open)}<span class="cm-link${embed ? ' cm-embed' : ''}${unresolved}"${data}>${escapeHtml(inner)}</span>${marker(']]')}`;
        i = close + 2;
        continue;
      }
    }

    if (ch === '[' || (ch === '!' && rest[1] === '[')) {
      const link = /^(!?)\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
      if (link) {
        flush();
        const href = link[3]!;
        const external = /^[a-z][\w+.-]*:/i.test(href);
        let data = '';
        if (external) {
          data = ` data-external="${attr(href)}"`;
        } else if (options.resolve) {
          const { target, subpath } = linkParts(decodeUriSafe(href));
          data = ` data-href="${attr(target)}" data-subpath="${attr(subpath)}" data-resolved="${attr(options.resolve(target) ?? '')}"`;
        }
        out += `${marker(`${link[1]!}[`)}<span class="cm-link-text">${escapeHtml(link[2]!)}</span>${marker('](')}<span class="cm-url"${data}>${escapeHtml(href)}</span>${marker(')')}`;
        i += link[0].length;
        continue;
      }
      const footnoteRef = /^\[\^([^\]]+)\]/.exec(rest);
      if (footnoteRef) {
        flush();
        out += span('cm-link', footnoteRef[0]);
        i += footnoteRef[0].length;
        continue;
      }
    }

    const pairs: [string, string][] = [
      ['***', 'cm-strong cm-em'],
      ['**', 'cm-strong'],
      ['~~', 'cm-strike'],
      ['==', 'cm-highlight'],
      ['__', 'cm-strong'],
    ];
    let handled = false;
    for (const [delim, cls] of pairs) {
      if (!rest.startsWith(delim)) continue;
      const close = text.indexOf(delim, i + delim.length);
      if (close === -1) continue;
      flush();
      out += `${marker(delim)}<span class="${cls}">${decorateInline(text.slice(i + delim.length, close), options)}</span>${marker(delim)}`;
      i = close + delim.length;
      handled = true;
      break;
    }
    if (handled) continue;

    if ((ch === '*' || ch === '_') && text[i + 1] !== ch) {
      const boundaryOk = ch === '*' || i === 0 || /[\s(["']/.test(text[i - 1]!);
      const close = boundaryOk ? text.indexOf(ch, i + 1) : -1;
      if (close > i + 1 && !/\s/.test(text[i + 1]!)) {
        flush();
        out += `${marker(ch)}<span class="cm-em">${decorateInline(text.slice(i + 1, close), options)}</span>${marker(ch)}`;
        i = close + 1;
        continue;
      }
    }

    if (ch === '#' && (i === 0 || /[\s([]/.test(text[i - 1]!))) {
      const tag = /^#([\p{L}\p{N}_/-]*[\p{L}\p{N}_/-])/u.exec(rest);
      if (tag && !/^\d+$/.test(tag[1]!)) {
        flush();
        out += span('cm-tag', tag[0]);
        i += tag[0].length;
        continue;
      }
    }

    if (ch === '^' && /^\^[\w-]+\s*$/.test(rest) && i > 0 && /\s/.test(text[i - 1]!)) {
      flush();
      out += span('cm-block-id', rest);
      i = text.length;
      continue;
    }

    const url = /^(https?:\/\/[^\s<>()[\]"']+)/.exec(rest);
    if (url && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      flush();
      out += `<span class="cm-url" data-external="${attr(url[0])}">${escapeHtml(url[0])}</span>`;
      i += url[0].length;
      continue;
    }

    plain += ch;
    i += 1;
  }
  flush();
  return out;
}
