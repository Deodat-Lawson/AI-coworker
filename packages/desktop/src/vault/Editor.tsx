/**
 * The markdown editor.
 *
 * Live Preview works block by block: every block renders as HTML except the one
 * holding the caret, which stays as decorated source you can type into.
 *
 * The document string is the model and the DOM is only ever a view of it. Every
 * edit is intercepted at `beforeinput`, applied to the string, and re-rendered —
 * the browser is never allowed to mutate the surface itself. That matters
 * because half the surface is `contenteditable="false"` rendered HTML: left to
 * its own devices, a backspace at the start of a paragraph would delete the
 * rendered table above it and take the source with it.
 *
 * The one exception is IME composition, which has to run natively; the DOM is
 * read back and reconciled when the composition ends.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { decorateLine } from './decorate.js';
import { parseBlocks, renderBlock, renderMarkdown, type Block, type RenderContext } from './markdown.js';

export type EditorMode = 'source' | 'live' | 'reading';

export interface Suggestion {
  id: string;
  label: string;
  detail?: string;
  /** Text that replaces the trigger query. */
  insert: string;
}

export interface EditorHandle {
  focus(): void;
  getValue(): string;
  getSelection(): { from: number; to: number };
  setSelection(from: number, to?: number): void;
  replaceRange(from: number, to: number, text: string, caret?: number): void;
  wrapSelection(before: string, after?: string): void;
  toggleLinePrefix(prefix: string, exclusive?: string[]): void;
  insertAtCaret(text: string, caretOffset?: number): void;
  scrollToLine(line: number, highlight?: boolean): void;
  caretLine(): number;
  undo(): void;
  redo(): void;
}

interface Props {
  value: string;
  mode: EditorMode;
  ctx: RenderContext;
  spellcheck?: boolean;
  showLineNumbers?: boolean;
  readOnly?: boolean;
  /** Redraw when this changes: transcluded notes may have finished loading. */
  revision?: number;
  onChange(next: string): void;
  onCaret?(offset: number, line: number): void;
  /** Candidate list for `[[`, `![[` and `#` triggers. */
  suggest?(kind: 'link' | 'tag', query: string): Suggestion[];
  onOpenLink?(target: string, subpath: string, resolved: string, event: MouseEvent): void;
  onTagClick?(tag: string): void;
  onExternal?(href: string): void;
  /** Fired when a task checkbox in the rendered output is clicked. */
  onToggleTask?(line: number): void;
}

interface HistoryEntry {
  text: string;
  from: number;
  to: number;
  at: number;
}

interface SelRange {
  from: number;
  to: number;
}

const WIDGET_CLASS = 'cm-widget';

/** Pairs that auto-close, and whose closer types over itself. */
const PAIRS: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
const CLOSERS = new Set(Object.values(PAIRS));

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

/** Blank runs stay as editable lines; everything else can become a widget. */
function isWidgetBlock(block: Block): boolean {
  return block.type !== 'blank';
}

const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const {
    value,
    mode,
    ctx,
    spellcheck = true,
    showLineNumbers = false,
    readOnly = false,
    revision = 0,
    onChange,
    onCaret,
    suggest,
    onOpenLink,
    onTagClick,
    onExternal,
    onToggleTask,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef(value);
  const selRef = useRef<SelRange>({ from: 0, to: 0 });
  const signatureRef = useRef('');
  const focusedRef = useRef(false);
  const composingRef = useRef(false);
  const historyRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const [suggestState, setSuggestState] = useState<{
    kind: 'link' | 'tag';
    query: string;
    from: number;
    items: Suggestion[];
    index: number;
    rect: { top: number; left: number } | null;
  } | null>(null);

  // -- model -> DOM ---------------------------------------------------------

  const resolveLink = useCallback(
    (target: string) => (target ? ctx.resolve(target, ctx.sourcePath) : ctx.sourcePath),
    [ctx],
  );

  const buildHtml = useCallback(
    (text: string, caret: number): { html: string; signature: string } => {
      const lines = text.split('\n');
      const blocks = parseBlocks(lines);
      const caretLine = lineOf(text, caret);
      const active =
        mode === 'live' && focusedRef.current
          ? blocks.findIndex((b) => caretLine >= b.from && caretLine < Math.max(b.to, b.from + 1))
          : -1;

      const parts: string[] = [];
      blocks.forEach((block, index) => {
        const asSource = mode === 'source' || index === active || !isWidgetBlock(block);
        if (asSource) {
          const inCode = block.type === 'code';
          for (let l = block.from; l < Math.max(block.to, block.from + 1); l += 1) {
            const raw = lines[l] ?? '';
            const isFenceEdge = inCode && (l === block.from || l === block.to - 1);
            // Only the caret's own line shows its syntax markers.
            const decorated = decorateLine(raw, {
              active: mode === 'source' || l === caretLine,
              inCode: inCode && !isFenceEdge,
              resolve: resolveLink,
            });
            parts.push(
              `<div class="cm-line${decorated ? '' : ' is-blank'}" data-line="${l}">${
                decorated || '<br />'
              }</div>`,
            );
          }
          return;
        }
        const raw = lines.slice(block.from, block.to).join('\n');
        parts.push(
          `<div class="${WIDGET_CLASS}" contenteditable="false" data-from="${block.from}" data-to="${block.to}" data-raw="${escapeAttr(raw)}">${renderBlock(block, ctx)}</div>`,
        );
      });

      // The caret line is part of the signature because moving between lines
      // changes which markers are hidden, not just which block is editable.
      const signature = `${mode}|${active}|${caretLine}|${blocks
        .map((b) => `${b.type}:${b.from}:${b.to}`)
        .join(',')}`;
      return { html: parts.join('') || '<div class="cm-line is-blank" data-line="0"><br /></div>', signature };
    },
    [ctx, mode, resolveLink],
  );

  const restoreSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root || !focusedRef.current) return;
    applySelection(root, selRef.current);
  }, []);

  const render = useCallback(
    (force = false) => {
      const root = rootRef.current;
      if (!root || mode === 'reading') return;
      const { html, signature } = buildHtml(textRef.current, selRef.current.to);
      if (!force && signature === signatureRef.current) return;
      signatureRef.current = signature;
      root.innerHTML = html;
      restoreSelection();
    },
    [buildHtml, mode, restoreSelection],
  );

  /** Re-decorate the caret's line without disturbing the rest of the DOM. */
  const patchCaretLine = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const lines = textRef.current.split('\n');
    const caretLine = lineOf(textRef.current, selRef.current.to);
    const node = root.querySelector<HTMLElement>(`.cm-line[data-line="${caretLine}"]`);
    if (!node) {
      render(true);
      return;
    }
    const blocks = parseBlocks(lines);
    const block = blocks.find((b) => caretLine >= b.from && caretLine < Math.max(b.to, b.from + 1));
    const inCode =
      block?.type === 'code' && caretLine !== block.from && caretLine !== block.to - 1;
    const decorated = decorateLine(lines[caretLine] ?? '', {
      active: true,
      inCode,
      resolve: resolveLink,
    });
    const html = decorated || '<br />';
    node.classList.toggle('is-blank', !decorated);
    if (node.innerHTML !== html) node.innerHTML = html;
    restoreSelection();
  }, [render, resolveLink, restoreSelection]);

  // -- the single mutation primitive ----------------------------------------

  const commit = useCallback(
    (
      text: string,
      selection: SelRange,
      options: { history?: boolean; force?: boolean; coalesce?: boolean } = {},
    ) => {
      const previous = textRef.current;
      const changed = text !== previous;
      if (changed && options.history !== false) {
        const history = historyRef.current;
        const last = history[history.length - 1];
        const now = Date.now();
        // A burst of typing collapses into one undo step.
        const canCoalesce =
          options.coalesce === true && last !== undefined && now - last.at < 600;
        if (canCoalesce) last.at = now;
        else history.push({ text: previous, from: selRef.current.from, to: selRef.current.to, at: now });
        if (history.length > 400) history.shift();
        futureRef.current = [];
      }
      textRef.current = text;
      selRef.current = {
        from: clamp(selection.from, 0, text.length),
        to: clamp(selection.to, 0, text.length),
      };
      if (changed) onChange(text);
      onCaret?.(selRef.current.to, lineOf(text, selRef.current.to));
      if (mode === 'reading') return;
      const { signature } = buildHtml(text, selRef.current.to);
      if (options.force || signature !== signatureRef.current) render(true);
      else patchCaretLine();
    },
    [buildHtml, mode, onCaret, onChange, patchCaretLine, render],
  );

  /** Replace a source range. The only way anything ever changes. */
  const applyEdit = useCallback(
    (from: number, to: number, insert: string, caret?: number, coalesce = false) => {
      const text = textRef.current;
      const start = clamp(Math.min(from, to), 0, text.length);
      const end = clamp(Math.max(from, to), 0, text.length);
      const next = `${text.slice(0, start)}${insert}${text.slice(end)}`;
      const position = caret ?? start + insert.length;
      commit(next, { from: position, to: position }, { coalesce });
    },
    [commit],
  );

  // -- reading the DOM selection back into model offsets --------------------

  const readSelection = useCallback((): SelRange | null => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) return null;
    if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
    const anchor = offsetOf(root, anchorNode, selection.anchorOffset);
    const focus = offsetOf(root, focusNode, selection.focusOffset);
    if (anchor < 0 || focus < 0) return null;
    return { from: Math.min(anchor, focus), to: Math.max(anchor, focus) };
  }, []);

  const syncSelection = useCallback(() => {
    if (composingRef.current) return;
    const next = readSelection();
    if (!next) return;
    const previous = selRef.current;
    if (next.from === previous.from && next.to === previous.to) return;
    selRef.current = next;
    onCaret?.(next.to, lineOf(textRef.current, next.to));
    if (mode === 'live') {
      const { signature } = buildHtml(textRef.current, next.to);
      if (signature !== signatureRef.current) render(true);
    }
  }, [buildHtml, mode, onCaret, readSelection, render]);

  // -- suggestions ----------------------------------------------------------

  const refreshSuggestions = useCallback(() => {
    if (!suggest) {
      setSuggestState(null);
      return;
    }
    const text = textRef.current;
    const caret = selRef.current.to;
    if (selRef.current.from !== caret) {
      setSuggestState(null);
      return;
    }
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const before = text.slice(lineStart, caret);

    const link = /(!?)\[\[([^\]\n]*)$/.exec(before);
    if (link) {
      const query = link[2]!;
      setSuggestState({
        kind: 'link',
        query,
        from: caret - query.length,
        items: suggest('link', query).slice(0, 50),
        index: 0,
        rect: caretRect(),
      });
      return;
    }
    const tag = /(?:^|[\s(>[])#([\p{L}\p{N}_/-]*)$/u.exec(before);
    if (tag) {
      const query = tag[1]!;
      const items = suggest('tag', query).slice(0, 50);
      if (items.length) {
        setSuggestState({
          kind: 'tag',
          query,
          from: caret - query.length,
          items,
          index: 0,
          rect: caretRect(),
        });
        return;
      }
    }
    setSuggestState(null);
  }, [suggest]);

  const acceptSuggestion = useCallback(
    (item: Suggestion) => {
      const state = suggestState;
      if (!state) return;
      const text = textRef.current;
      const caret = selRef.current.to;
      setSuggestState(null);
      if (state.kind === 'tag') {
        applyEdit(state.from, caret, item.insert);
        return;
      }
      // Close the link if the brackets are not already there, and leave the
      // caret after them so typing continues in the sentence.
      const after = text.slice(caret);
      const closing = after.startsWith(']]') ? 2 : 0;
      const insert = closing ? item.insert : `${item.insert}]]`;
      const end = state.from + insert.length + closing;
      applyEdit(state.from, caret, insert, end);
    },
    [applyEdit, suggestState],
  );

  // -- editing intents -------------------------------------------------------

  const smartEnter = useCallback(() => {
    const text = textRef.current;
    const { from, to } = selRef.current;
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const lineEndIndex = text.indexOf('\n', to);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const line = text.slice(lineStart, lineEnd);

    // Inside a fenced block, Enter is just a newline.
    const blocks = parseBlocks(text.split('\n'));
    const caretLine = lineOf(text, from);
    const block = blocks.find((b) => caretLine >= b.from && caretLine < Math.max(b.to, b.from + 1));
    if (block?.type === 'code' && caretLine !== block.from) {
      applyEdit(from, to, '\n');
      return;
    }

    if (from === to) {
      const list = /^(\s*)([-*+]|\d+[.)])(\s+)(\[(.)\]\s+)?(.*)$/.exec(line);
      if (list) {
        const [, indentText, marker, space, task, , rest] = list;
        if (!rest!.trim()) {
          // A second Enter on an empty item ends the list.
          applyEdit(lineStart, lineEnd, indentText!, lineStart + indentText!.length);
          return;
        }
        const nextMarker = /\d/.test(marker!)
          ? `${Number(marker!.replace(/\D/g, '')) + 1}${marker!.replace(/\d/g, '')}`
          : marker!;
        applyEdit(from, to, `\n${indentText}${nextMarker}${space}${task ? '[ ] ' : ''}`);
        return;
      }
      const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line);
      if (quote) {
        if (!quote[2]!.trim()) {
          applyEdit(lineStart, lineEnd, '', lineStart);
          return;
        }
        applyEdit(from, to, `\n${quote[1]}`);
        return;
      }
    }
    applyEdit(from, to, '\n');
  }, [applyEdit]);

  const indent = useCallback(
    (direction: 1 | -1) => {
      const text = textRef.current;
      const { from, to } = selRef.current;
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      const lineEndIndex = text.indexOf('\n', to);
      const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
      const spansLines = text.slice(from, to).includes('\n');
      const line = text.slice(lineStart, lineEnd);
      const isList = /^\s*([-*+]|\d+[.)])\s/.test(line);

      // A plain Tab inside prose inserts a tab; in a list, or across a
      // selection, it shifts the lines the way an outliner does.
      if (direction === 1 && from === to && !isList && !spansLines) {
        applyEdit(from, to, '\t');
        return;
      }

      const body = text.slice(lineStart, lineEnd);
      const changed = body
        .split('\n')
        .map((l) => (direction === 1 ? `\t${l}` : l.replace(/^(\t|\s{1,4})/, '')))
        .join('\n');
      if (changed === body) return;
      const firstDelta =
        direction === 1
          ? 1
          : -(body.length - body.replace(/^(\t|\s{1,4})/, '').length);
      const totalDelta = changed.length - body.length;
      commit(
        `${text.slice(0, lineStart)}${changed}${text.slice(lineEnd)}`,
        {
          from: Math.max(lineStart, from + firstDelta),
          to: Math.max(lineStart, to + (spansLines ? totalDelta : firstDelta)),
        },
        { force: true },
      );
    },
    [applyEdit, commit],
  );

  const wrapSelection = useCallback(
    (before: string, after = before) => {
      const { from, to } = selRef.current;
      const text = textRef.current;
      const selected = text.slice(from, to);
      // Already wrapped, either just inside or including the markers.
      if (
        text.slice(Math.max(0, from - before.length), from) === before &&
        text.slice(to, to + after.length) === after
      ) {
        commit(
          `${text.slice(0, from - before.length)}${selected}${text.slice(to + after.length)}`,
          { from: from - before.length, to: to - before.length },
          { force: true },
        );
        return;
      }
      if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
        const inner = selected.slice(before.length, selected.length - after.length);
        commit(`${text.slice(0, from)}${inner}${text.slice(to)}`, { from, to: from + inner.length }, { force: true });
        return;
      }
      const next = `${text.slice(0, from)}${before}${selected}${after}${text.slice(to)}`;
      commit(
        next,
        selected
          ? { from: from + before.length, to: to + before.length }
          : { from: from + before.length, to: from + before.length },
        { force: true },
      );
    },
    [commit],
  );

  const toggleLinePrefix = useCallback(
    (prefix: string, exclusive: string[] = []) => {
      const text = textRef.current;
      const { from, to } = selRef.current;
      const start = text.lastIndexOf('\n', from - 1) + 1;
      const endIndex = text.indexOf('\n', to);
      const end = endIndex === -1 ? text.length : endIndex;
      const lines = text.slice(start, end).split('\n');
      const all = lines.every((l) => l.trimStart().startsWith(prefix));
      const next = lines
        .map((line) => {
          const indentText = line.slice(0, line.length - line.trimStart().length);
          let body = line.trimStart();
          for (const other of exclusive) {
            if (body.startsWith(other)) body = body.slice(other.length);
          }
          if (all) return indentText + (body.startsWith(prefix) ? body.slice(prefix.length) : body);
          return body.startsWith(prefix) ? indentText + body : indentText + prefix + body;
        })
        .join('\n');
      const delta = next.length - (end - start);
      commit(`${text.slice(0, start)}${next}${text.slice(end)}`, {
        from: Math.max(start, from + (all ? -prefix.length : prefix.length)),
        to: Math.max(start, to + delta),
      }, { force: true });
    },
    [commit],
  );

  const undo = useCallback(() => {
    const entry = historyRef.current.pop();
    if (!entry) return;
    futureRef.current.push({
      text: textRef.current,
      from: selRef.current.from,
      to: selRef.current.to,
      at: Date.now(),
    });
    commit(entry.text, { from: entry.from, to: entry.to }, { history: false, force: true });
  }, [commit]);

  const redo = useCallback(() => {
    const entry = futureRef.current.pop();
    if (!entry) return;
    historyRef.current.push({
      text: textRef.current,
      from: selRef.current.from,
      to: selRef.current.to,
      at: Date.now(),
    });
    commit(entry.text, { from: entry.from, to: entry.to }, { history: false, force: true });
  }, [commit]);

  // -- beforeinput: every edit funnels through here -------------------------

  const handleBeforeInput = useCallback(
    (event: InputEvent) => {
      if (readOnly) {
        event.preventDefault();
        return;
      }
      const type = event.inputType;

      // Composition runs natively and is reconciled on compositionend.
      if (type === 'insertCompositionText' || type === 'deleteCompositionText') return;

      const dom = readSelection();
      if (dom) selRef.current = dom;
      const { from, to } = selRef.current;
      const text = textRef.current;

      switch (type) {
        case 'insertText':
        case 'insertReplacementText': {
          event.preventDefault();
          const data = event.data ?? '';
          if (!data) return;
          // Typing a closer when one is already there steps over it.
          if (from === to && CLOSERS.has(data) && text[from] === data) {
            commit(text, { from: from + 1, to: from + 1 }, { history: false });
            return;
          }
          if (PAIRS[data]) {
            if (from !== to) {
              wrapSelection(data, PAIRS[data]!);
              window.setTimeout(refreshSuggestions, 0);
              return;
            }
            applyEdit(from, to, `${data}${PAIRS[data]}`, from + 1);
            window.setTimeout(refreshSuggestions, 0);
            return;
          }
          applyEdit(from, to, data, undefined, data !== ' ' && data !== '\n');
          window.setTimeout(refreshSuggestions, 0);
          return;
        }

        case 'insertParagraph':
        case 'insertLineBreak': {
          event.preventDefault();
          smartEnter();
          setSuggestState(null);
          return;
        }

        case 'insertFromPaste':
        case 'insertFromDrop':
        case 'insertFromYank': {
          event.preventDefault();
          const pasted = event.dataTransfer?.getData('text/plain') ?? '';
          if (pasted) applyEdit(from, to, pasted);
          return;
        }

        case 'deleteContentBackward':
        case 'deleteContentForward':
        case 'deleteWordBackward':
        case 'deleteWordForward':
        case 'deleteSoftLineBackward':
        case 'deleteSoftLineForward':
        case 'deleteHardLineBackward':
        case 'deleteHardLineForward':
        case 'deleteByCut':
        case 'deleteByDrag':
        case 'deleteContent': {
          event.preventDefault();
          const range = deletionRange(text, { from, to }, type);
          if (range.from === range.to) return;
          applyEdit(range.from, range.to, '', undefined, true);
          window.setTimeout(refreshSuggestions, 0);
          return;
        }

        case 'historyUndo': {
          event.preventDefault();
          undo();
          return;
        }
        case 'historyRedo': {
          event.preventDefault();
          redo();
          return;
        }

        default: {
          // Formatting commands and anything unrecognised must not be allowed
          // to touch the DOM behind the model's back.
          event.preventDefault();
        }
      }
    },
    [applyEdit, commit, readOnly, readSelection, redo, refreshSuggestions, smartEnter, undo, wrapSelection],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const meta = event.metaKey || event.ctrlKey;

      if (suggestState) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const count = Math.max(1, suggestState.items.length);
          setSuggestState({ ...suggestState, index: (suggestState.index + delta + count) % count });
          return;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && suggestState.items.length) {
          event.preventDefault();
          acceptSuggestion(suggestState.items[suggestState.index]!);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setSuggestState(null);
          return;
        }
      }

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (meta && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        wrapSelection('**');
        return;
      }
      if (meta && !event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        wrapSelection('*');
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        wrapSelection('==');
        return;
      }
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const { from, to } = selRef.current;
        const label = textRef.current.slice(from, to);
        applyEdit(from, to, `[${label}]()`, from + label.length + 3);
        return;
      }
      if (event.key === 'Tab' && !meta) {
        event.preventDefault();
        indent(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape') {
        setSuggestState(null);
      }
    },
    [acceptSuggestion, applyEdit, indent, redo, suggestState, undo, wrapSelection],
  );

  // -- clipboard -------------------------------------------------------------

  const writeClipboard = useCallback((event: React.ClipboardEvent) => {
    const { from, to } = selRef.current;
    if (from === to) return false;
    // Copy the markdown, not the rendered text the selection may have crossed.
    event.clipboardData.setData('text/plain', textRef.current.slice(from, to));
    event.preventDefault();
    return true;
  }, []);

  // -- pointer ---------------------------------------------------------------

  const caretFromPoint = useCallback((clientX: number, clientY: number, anchor: HTMLElement) => {
    const line = Number(anchor.dataset.l ?? 0);
    let column = Number(anchor.dataset.o ?? 0);
    if (anchor.dataset.o !== undefined) {
      const range = caretRangeFromPoint(clientX, clientY);
      if (range && anchor.contains(range.startContainer)) {
        column += offsetWithin(anchor, range.startContainer, range.startOffset);
      }
    }
    const lines = textRef.current.split('\n');
    const target = Math.min(Math.max(0, line), lines.length - 1);
    return (
      lines.slice(0, target).reduce((acc, l) => acc + l.length + 1, 0) +
      Math.min(column, (lines[target] ?? '').length)
    );
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('a, input, button, .md-callout-title')) return;
      const widget = target.closest(`.${WIDGET_CLASS}`) as HTMLElement | null;
      if (!widget) return;
      const anchor = (target.closest('[data-l]') as HTMLElement | null) ?? widget;
      const offset = anchor.dataset.l
        ? caretFromPoint(event.clientX, event.clientY, anchor)
        : lineStartOffset(textRef.current, Number(widget.dataset.from ?? 0));
      event.preventDefault();
      focusedRef.current = true;
      selRef.current = { from: offset, to: offset };
      render(true);
      rootRef.current?.focus();
      restoreSelection();
      onCaret?.(offset, lineOf(textRef.current, offset));
    },
    [caretFromPoint, onCaret, render, restoreSelection],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;

      const checkbox = target.closest('input.md-task') as HTMLInputElement | null;
      if (checkbox) {
        event.preventDefault();
        const line = Number(checkbox.dataset.taskLine ?? -1);
        const lines = textRef.current.split('\n');
        const raw = lines[line];
        if (line >= 0 && raw !== undefined) {
          const done = /^\s*[-*+]\s+\[[^ ]\]/.test(raw);
          const start = lineStartOffset(textRef.current, line);
          const next = raw.replace(/^(\s*[-*+]\s+\[)(.)(\])/, `$1${done ? ' ' : 'x'}$3`);
          commit(
            `${textRef.current.slice(0, start)}${next}${textRef.current.slice(start + raw.length)}`,
            selRef.current,
            { force: true },
          );
          onToggleTask?.(line);
        }
        return;
      }

      const copy = target.closest('button.md-copy') as HTMLElement | null;
      if (copy) {
        event.preventDefault();
        void navigator.clipboard.writeText(copy.dataset.copy ?? '');
        const original = copy.textContent;
        copy.textContent = 'Copied';
        window.setTimeout(() => {
          copy.textContent = original;
        }, 1200);
        return;
      }

      const foldTitle = target.closest('.md-callout.is-foldable .md-callout-title') as HTMLElement | null;
      if (foldTitle) {
        foldTitle.parentElement?.classList.toggle('is-collapsed');
        return;
      }

      const inSource = Boolean(target.closest('.cm-line'));
      // In a line you are editing, a link needs the modifier — a plain click
      // there is how you put the caret in the middle of the link text.
      const wantsNavigation = !inSource || event.metaKey || event.ctrlKey;

      const tag = target.closest('[data-tag]') as HTMLElement | null;
      if (tag && wantsNavigation) {
        event.preventDefault();
        onTagClick?.(tag.dataset.tag ?? '');
        return;
      }

      const external = target.closest('[data-external]') as HTMLElement | null;
      if (external && wantsNavigation) {
        event.preventDefault();
        onExternal?.(external.dataset.external ?? '');
        return;
      }

      const link = target.closest('[data-href]') as HTMLElement | null;
      if (link && wantsNavigation) {
        event.preventDefault();
        onOpenLink?.(
          link.dataset.href ?? '',
          link.dataset.subpath ?? '',
          link.dataset.resolved ?? '',
          event.nativeEvent,
        );
        return;
      }

      syncSelection();
    },
    [commit, onExternal, onOpenLink, onTagClick, onToggleTask, syncSelection],
  );

  // -- lifecycle ------------------------------------------------------------

  useEffect(() => {
    if (value === textRef.current) return;
    textRef.current = value;
    selRef.current = {
      from: clamp(selRef.current.from, 0, value.length),
      to: clamp(selRef.current.to, 0, value.length),
    };
    historyRef.current = [];
    futureRef.current = [];
    signatureRef.current = '';
    render(true);
  }, [render, value]);

  useLayoutEffect(() => {
    signatureRef.current = '';
    render(true);
  }, [mode, render, revision]);

  // `beforeinput` is bound to the element directly: React's synthetic version
  // is a composition-oriented polyfill and never reports deleteWordBackward and
  // friends, which are exactly the intents this editor has to own.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const listener = (event: Event) => handleBeforeInput(event as InputEvent);
    root.addEventListener('beforeinput', listener);
    return () => root.removeEventListener('beforeinput', listener);
  }, [handleBeforeInput]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      focus: () => {
        focusedRef.current = true;
        rootRef.current?.focus();
        render(true);
        restoreSelection();
      },
      getValue: () => textRef.current,
      getSelection: () => ({ ...selRef.current }),
      setSelection: (from, to) => {
        selRef.current = {
          from: clamp(from, 0, textRef.current.length),
          to: clamp(to ?? from, 0, textRef.current.length),
        };
        render(true);
        restoreSelection();
      },
      replaceRange: (from, to, text, caret) => applyEdit(from, to, text, caret),
      wrapSelection,
      toggleLinePrefix,
      insertAtCaret: (text, caretOffset) => {
        const { from, to } = selRef.current;
        applyEdit(from, to, text, from + (caretOffset ?? text.length));
      },
      scrollToLine: (line, highlight) => {
        const root = rootRef.current;
        if (!root) return;
        const node =
          root.querySelector<HTMLElement>(`.cm-line[data-line="${line}"]`) ??
          root.querySelector<HTMLElement>(`[data-l="${line}"]`) ??
          [...root.querySelectorAll<HTMLElement>(`.${WIDGET_CLASS}`)].find(
            (w) => Number(w.dataset.from) <= line && line < Number(w.dataset.to),
          );
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (node && highlight) {
          node.classList.add('is-flashing');
          window.setTimeout(() => node.classList.remove('is-flashing'), 1400);
        }
      },
      caretLine: () => lineOf(textRef.current, selRef.current.to),
      undo,
      redo,
    }),
    [applyEdit, redo, render, restoreSelection, toggleLinePrefix, undo, wrapSelection],
  );

  if (mode === 'reading') {
    return (
      <div
        className="md-reading markdown-body"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(value, ctx) }}
      />
    );
  }

  return (
    <div className="cm-wrap">
      <div
        ref={rootRef}
        className={`cm-editor markdown-body${showLineNumbers ? ' with-numbers' : ''}`}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={spellcheck}
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        onInput={() => {
          // Nothing should reach here except composition; if the DOM drifted
          // from the model anyway, take the DOM as truth rather than lose text.
          if (composingRef.current) return;
          const root = rootRef.current;
          if (!root) return;
          const domText = serialize(root);
          if (domText !== textRef.current) {
            const caret = readSelection();
            commit(domText, caret ?? selRef.current, { force: true });
          }
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncSelection}
        onMouseUp={syncSelection}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onSelect={syncSelection}
        onCopy={writeClipboard}
        onCut={(event) => {
          if (!writeClipboard(event)) return;
          const { from, to } = selRef.current;
          applyEdit(from, to, '');
        }}
        onFocus={() => {
          focusedRef.current = true;
          render(true);
        }}
        onBlur={() => {
          focusedRef.current = false;
          setSuggestState(null);
          render(true);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          const root = rootRef.current;
          if (!root) return;
          const domText = serialize(root);
          const caret = readSelection();
          commit(domText, caret ?? selRef.current, { force: true });
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text/plain');
          if (!text) return;
          event.preventDefault();
          const { from, to } = selRef.current;
          applyEdit(from, to, text);
        }}
      />
      {suggestState && suggestState.items.length > 0 && suggestState.rect ? (
        <div
          className="cm-suggest"
          style={{ top: suggestState.rect.top, left: suggestState.rect.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggestState.items.map((item, index) => (
            <button
              key={item.id}
              className={`cm-suggest-item${index === suggestState.index ? ' is-active' : ''}`}
              onClick={() => acceptSuggestion(item)}
              type="button"
            >
              <span className="cm-suggest-label">{item.label}</span>
              {item.detail ? <span className="cm-suggest-detail">{item.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export default Editor;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function lineOf(text: string, offset: number): number {
  let line = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function lineStartOffset(text: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return offset;
    offset = next + 1;
  }
  return offset;
}

let graphemes: Intl.Segmenter | null | undefined;

/** One user-perceived character back from `at`, emoji and all. */
function graphemeStart(text: string, at: number): number {
  if (at <= 0) return 0;
  if (graphemes === undefined) {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    graphemes = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (graphemes) {
    const slice = text.slice(Math.max(0, at - 32), at);
    const segments = [...graphemes.segment(slice)];
    const last = segments[segments.length - 1];
    if (last) return at - last.segment.length;
  }
  const code = text.codePointAt(at - 2);
  return code !== undefined && code > 0xffff ? at - 2 : at - 1;
}

function wordStart(text: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1]!) && text[i - 1] !== '\n') i -= 1;
  if (i > 0 && text[i - 1] === '\n') return i - 1;
  while (i > 0 && /[\w'-]/.test(text[i - 1]!)) i -= 1;
  return i === at ? Math.max(0, at - 1) : i;
}

function wordEnd(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i]!) && text[i] !== '\n') i += 1;
  if (i < text.length && text[i] === '\n') return i + 1;
  while (i < text.length && /[\w'-]/.test(text[i]!)) i += 1;
  return i === at ? Math.min(text.length, at + 1) : i;
}

/** Translate a delete intent into a concrete source range. */
export function deletionRange(text: string, selection: SelRange, inputType: string): SelRange {
  const { from, to } = selection;
  if (from !== to) return { from, to };
  switch (inputType) {
    case 'deleteContentForward':
      return { from, to: Math.min(text.length, (text.codePointAt(from) ?? 0) > 0xffff ? from + 2 : from + 1) };
    case 'deleteWordBackward':
      return { from: wordStart(text, from), to };
    case 'deleteWordForward':
      return { from, to: wordEnd(text, from) };
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward':
      return { from: text.lastIndexOf('\n', from - 1) + 1, to };
    case 'deleteSoftLineForward':
    case 'deleteHardLineForward': {
      const end = text.indexOf('\n', from);
      return { from, to: end === -1 ? text.length : end };
    }
    default:
      return { from: graphemeStart(text, from), to };
  }
}

// ---------------------------------------------------------------------------
// DOM <-> text
// ---------------------------------------------------------------------------

function textLengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
  if (node.nodeName === 'BR') return 0;
  const el = node as HTMLElement;
  if (el.classList?.contains(WIDGET_CLASS)) return (el.dataset.raw ?? '').length;
  let total = 0;
  node.childNodes.forEach((child) => {
    total += textLengthOf(child);
  });
  return total;
}

/** The markdown the current DOM represents. Only used to recover from IME. */
function serialize(root: HTMLElement): string {
  const parts: string[] = [];
  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList.contains(WIDGET_CLASS)) {
      parts.push((child as HTMLElement).dataset.raw ?? '');
      return;
    }
    parts.push(collectText(child));
  });
  return parts.join('\n');
}

function collectText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeName === 'BR') return '';
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList.contains(WIDGET_CLASS)) {
    return (node as HTMLElement).dataset.raw ?? '';
  }
  let out = '';
  node.childNodes.forEach((child) => {
    out += collectText(child);
  });
  return out;
}

/** Model offset for a DOM position, walking children in document order. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const children = Array.from(root.childNodes);

  if (node === root) {
    let acc = 0;
    for (let i = 0; i < offset && i < children.length; i += 1) {
      acc += textLengthOf(children[i]!) + 1;
    }
    return Math.max(0, acc - 1);
  }

  let base = 0;
  for (const child of children) {
    const contains = child === node || child.contains(node);
    if (contains) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList.contains(WIDGET_CLASS)) {
        // Inside rendered output there is no one-to-one text mapping, but every
        // run carries the line and column it came from — so a selection can
        // still land on the right source character.
        return widgetOffset(child as HTMLElement, node, offset, base);
      }
      return base + innerOffset(child, node, offset);
    }
    base += textLengthOf(child) + 1;
  }
  return -1;
}

/** Map a position inside a rendered block back to a source offset. */
function widgetOffset(widget: HTMLElement, node: Node, offset: number, base: number): number {
  const raw = widget.dataset.raw ?? '';
  const from = Number(widget.dataset.from ?? 0);
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const anchor = element?.closest('[data-l][data-o]') as HTMLElement | null;
  if (!anchor) return base;
  const line = Number(anchor.dataset.l) - from;
  const column = Number(anchor.dataset.o) + innerOffset(anchor, node, offset);
  if (!Number.isFinite(line) || line < 0) return base;
  const lines = raw.split('\n');
  if (line >= lines.length) return base + raw.length;
  let acc = 0;
  for (let i = 0; i < line; i += 1) acc += (lines[i] ?? '').length + 1;
  return base + Math.min(acc + Math.min(column, (lines[line] ?? '').length), raw.length);
}

function innerOffset(root: Node, node: Node, offset: number): number {
  let total = 0;
  let found = false;

  const walk = (current: Node): void => {
    if (found) return;
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        total += Math.min(offset, current.nodeValue?.length ?? 0);
      } else {
        for (let i = 0; i < offset && i < current.childNodes.length; i += 1) {
          total += textLengthOf(current.childNodes[i]!);
        }
      }
      found = true;
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += current.nodeValue?.length ?? 0;
      return;
    }
    if (current.nodeName === 'BR') return;
    if (
      current.nodeType === Node.ELEMENT_NODE &&
      (current as HTMLElement).classList.contains(WIDGET_CLASS)
    ) {
      total += ((current as HTMLElement).dataset.raw ?? '').length;
      return;
    }
    Array.from(current.childNodes).forEach(walk);
  };

  walk(root);
  return total;
}

/** Put a DOM selection at a model range, mirroring `offsetOf`. */
function applySelection(root: HTMLElement, range: SelRange): void {
  const start = locate(root, range.from);
  const end = range.from === range.to ? start : locate(root, range.to);
  if (!start || !end) return;
  const selection = window.getSelection();
  if (!selection) return;
  const domRange = document.createRange();
  try {
    domRange.setStart(start.node, start.offset);
    domRange.setEnd(end.node, end.offset);
  } catch {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(domRange);
}

function locate(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
  let remaining = offset;
  const children = Array.from(root.childNodes);

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (index > 0) {
      if (remaining === 0) {
        const first = firstTextNode(child);
        return first ? { node: first, offset: 0 } : { node: child, offset: 0 };
      }
      remaining -= 1;
    }
    const length = textLengthOf(child);
    if (remaining > length) {
      remaining -= length;
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList.contains(WIDGET_CLASS)) {
      const parent = child.parentNode;
      if (!parent) return null;
      return { node: parent, offset: Array.from(parent.childNodes).indexOf(child as ChildNode) };
    }
    const found = descend(child, remaining);
    if (found) return found;
    return { node: child, offset: 0 };
  }

  const last = children[children.length - 1];
  if (!last) return { node: root, offset: 0 };
  const text = lastTextNode(last);
  return text ? { node: text, offset: text.nodeValue?.length ?? 0 } : { node: root, offset: children.length };
}

function descend(node: Node, offset: number): { node: Node; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return { node, offset: Math.min(offset, node.nodeValue?.length ?? 0) };
  }
  let remaining = offset;
  for (const child of Array.from(node.childNodes)) {
    const length = textLengthOf(child);
    if (remaining <= length) {
      const found = descend(child, remaining);
      if (found) return found;
    }
    remaining -= length;
  }
  const fallback = lastTextNode(node);
  return fallback ? { node: fallback, offset: fallback.nodeValue?.length ?? 0 } : null;
}

function firstTextNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of Array.from(node.childNodes)) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return null;
}

function lastTextNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of Array.from(node.childNodes).reverse()) {
    const found = lastTextNode(child);
    if (found) return found;
  }
  return null;
}

function offsetWithin(root: HTMLElement, node: Node, offset: number): number {
  return innerOffset(root, node, offset);
}

function caretRangeFromPoint(x: number, y: number): globalThis.Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  return range;
}

function caretRect(): { top: number; left: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
  if (!rect || (!rect.top && !rect.left)) return null;
  return { top: rect.bottom + 4, left: rect.left };
}
